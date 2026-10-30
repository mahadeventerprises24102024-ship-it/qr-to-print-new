"use strict";

// Opt-in test upload flow. Never enable for actual customer documents without
// malware scanning, storage lifecycle policies, monitoring and durable DB.
const { randomUUID, createHash, randomBytes } = require("node:crypto");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Anonymous test uploads require a second explicit owner-controlled opt-in.
// Having private R2 storage enabled alone must never enable guest submissions.
function guestTestUploadsEnabled(env = process.env) {
  return env.ENABLE_GUEST_TEST_UPLOADS === "true" &&
    storageSettings(env).enabled;
}
const allowedTypes = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg"
};

function storageSettings(env = process.env) {
  const endpoint = env.FILE_STORAGE_ENDPOINT || "";
  const bucket = env.FILE_STORAGE_BUCKET || "";
  const accessKeyId = env.FILE_STORAGE_ACCESS_KEY_ID || "";
  const secretAccessKey = env.FILE_STORAGE_SECRET_ACCESS_KEY || "";
  let endpointValid = false;
  try {
    const url = new URL(endpoint);
    endpointValid = (
      url.protocol === "https:" &&
      /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) &&
      url.pathname === "/" && !url.search && !url.hash &&
      !url.username && !url.password
    );
  } catch { /* A missing or malformed endpoint disables uploads. */ }
  const validBucket = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket);
  const enabled = env.ENABLE_TEST_UPLOADS === "true" &&
    endpointValid && validBucket && !!accessKeyId && !!secretAccessKey;
  return { enabled, endpoint, bucket, accessKeyId, secretAccessKey };
}

function detectSafeFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;
  const data = file.buffer;
  if (data.length < 8 || data.length > MAX_FILE_BYTES) return null;
  const mime = String(file.mimetype || "");
  const fileName = String(file.originalname || "");
  const extension = fileName.split(".").pop().toLowerCase();
  let detected = null;
  if (data.subarray(0, 5).toString("ascii") === "%PDF-" &&
      data.subarray(Math.max(0, data.length - 1024)).includes(Buffer.from("%%EOF"))) {
    detected = "pdf";
  } else if (data.subarray(0, 8).equals(
      Buffer.from([137,80,78,71,13,10,26,10])) &&
      data.subarray(12, 16).toString("ascii") === "IHDR") {
    detected = "png";
  } else if (data[0] === 255 && data[1] === 216 && data[2] === 255 &&
      data[data.length - 2] === 255 && data[data.length - 1] === 217) {
    detected = "jpeg";
  }
  if (!detected) return null;
  if (mime !== allowedTypes[detected]) return null;
  if (!({
    pdf: ["pdf"],
    png: ["png"],
    jpeg: ["jpg", "jpeg"]
  })[detected].includes(extension)) return null;
  return detected;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
    fields: 3,
    parts: 4,
    fieldSize: 50
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many test uploads. Try again later." }
});

async function ensureTestUploadTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_file_orders (
      id BIGSERIAL PRIMARY KEY,
      shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
      storage_key TEXT NOT NULL UNIQUE,
      file_type VARCHAR(8) NOT NULL
        CHECK (file_type IN ('pdf','png','jpeg')),
      file_size_bytes INTEGER NOT NULL
        CHECK (file_size_bytes BETWEEN 8 AND 2097152),
      file_sha256 VARCHAR(64) NOT NULL,
      copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 10),
      print_mode VARCHAR(8) NOT NULL CHECK (print_mode IN ('bw','color')),
      status VARCHAR(16) NOT NULL DEFAULT 'test_only'
        CHECK (status IN ('test_only','printed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // PostgreSQL names this column CHECK test_file_orders_status_check
  // for the previous test-only schema. Replace it atomically. Do not use
  // anonymous DO blocks here: malformed dollar quoting prevents boot.
  await pool.query(`
    ALTER TABLE test_file_orders
      DROP CONSTRAINT IF EXISTS test_file_orders_status_check,
      ADD CONSTRAINT test_file_orders_status_check
      CHECK (status IN ('test_only','accepted','rejected','printed'))
  `);
  await pool.query("ALTER TABLE test_file_orders ADD COLUMN IF NOT EXISTS tracking_token_hash VARCHAR(64)");
  await pool.query("ALTER TABLE test_file_orders ADD COLUMN IF NOT EXISTS file_deleted_at TIMESTAMPTZ");
  // DUMMY front/back photos become one composite PNG. Real IDs remain unsupported.
  await pool.query("ALTER TABLE test_file_orders ADD COLUMN IF NOT EXISTS document_kind VARCHAR(30) NOT NULL DEFAULT 'regular_test'");
  await pool.query("ALTER TABLE test_file_orders DROP CONSTRAINT IF EXISTS test_file_orders_document_kind_check");
  await pool.query("ALTER TABLE test_file_orders ADD CONSTRAINT test_file_orders_document_kind_check CHECK (document_kind IN ('regular_test','dummy_card_front_back'))");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS test_file_orders_tracking_hash_unique
    ON test_file_orders(tracking_token_hash)
    WHERE tracking_token_hash IS NOT NULL
  `);
  // Existing installations created customer_id as NOT NULL. Permit NULL for
  // guest sample files while preserving the foreign key on registered accounts.
  await pool.query("ALTER TABLE test_file_orders ALTER COLUMN customer_id DROP NOT NULL");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS test_file_orders_shop_recent
    ON test_file_orders(shop_id, created_at DESC, id DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS test_file_orders_customer_recent
    ON test_file_orders(customer_id, created_at DESC, id DESC)
  `);
}

// Best-effort deletion of expired SAMPLE objects, preserving non-sensitive order
// metadata. Keep the R2 1-day lifecycle rule as an independent safety backstop.
async function purgeExpiredTestFiles(pool, env=process.env, dependencies={}) {
  const cfg=storageSettings(env);
  if(!cfg.enabled)return {storageEnabled:false,purged:0,failed:0};
  const client=dependencies.client || new S3Client({
    endpoint:cfg.endpoint,region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey}
  });
  let found;
  try{
    found=await pool.query(
      `SELECT id,storage_key FROM test_file_orders
       WHERE created_at < NOW() - INTERVAL '24 hours'
         AND file_deleted_at IS NULL
       ORDER BY created_at ASC, id ASC LIMIT 25`
    );
  }catch(error){
    console.error("Expired sample cleanup query failed:",error);
    return {storageEnabled:true,purged:0,failed:1};
  }
  let purged=0,failed=0;
  for(const record of found.rows){
    try{
      await client.send(new DeleteObjectCommand({Bucket:cfg.bucket,Key:record.storage_key}));
      const result=await pool.query(
        `UPDATE test_file_orders SET file_deleted_at=NOW()
         WHERE id=$1 AND storage_key=$2
           AND file_deleted_at IS NULL AND created_at < NOW() - INTERVAL '24 hours'`,
        [record.id,record.storage_key]
      );
      if(result.rowCount)purged++;
    }catch(error){
      failed++;
      console.error("Expired sample cleanup failed for order",record.id,error);
    }
  }
  return {storageEnabled:true,purged,failed};
}

// Possession of a random per-order tracking code permits status-only lookup.
const TRACK_TOKEN = /^[a-f0-9]{48}$/;
const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many status checks. Try again later." }
});
function trackingHash(token) {
  return TRACK_TOKEN.test(token || "") ?
    createHash("sha256").update(token).digest("hex") : null;
}
function installTestFileUploads(app, pool, env = process.env) {
  const cfg = storageSettings(env);
  const guestUploads = guestTestUploadsEnabled(env);
  const storage = cfg.enabled ? new S3Client({
    endpoint: cfg.endpoint,
    region: "auto",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey
    }
  }) : null;

  function requireShopOwner(req, res, next) {
    if (!req.session || !req.session.shopOwnerId) {
      return res.status(401).json({ error: "Shop login required" });
    }
    next();
  }

  function requireCustomer(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: "Customer login required" });
    }
    next();
  }

  function requireCustomerOrGuest(req, res, next) {
    if (req.session && req.session.userId) return next();
    if (guestUploads) return next();
    return res.status(401).json({ error: "Customer login required; guest test uploads are disabled" });
  }

  app.get("/api/test-upload/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      enabled: !!storage,
      customerLoginRequired: !guestUploads,
      guestTestUploadsEnabled: guestUploads,
      maxFileBytes: MAX_FILE_BYTES,
      testOnly: true
    });
  });

  app.post("/api/public/shops/:code/test-file-orders",
    requireCustomerOrGuest, uploadLimiter, (req, res) => {
      if (!storage) {
        return res.status(503).json({
          error: "Private test storage is not configured yet"
        });
      }

      upload.single("file")(req, res, async (uploadError) => {
        if (uploadError) {
          return res.status(
            uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400
          ).json({ error: "Invalid upload. Maximum 2 MB, one file." });
        }

        const code = req.params.code;
        const fileType = detectSafeFile(req.file);
        const copies = Number(req.body && req.body.copies);
        const printMode = req.body && req.body.printMode;
        const documentKind = (req.body && req.body.documentKind) || "regular_test";

        if (!/^[a-f0-9]{32}$/.test(code || "") ||
            !fileType || !Number.isInteger(copies) ||
            copies < 1 || copies > 10 ||
            !["bw", "color"].includes(printMode) ||
            !["regular_test", "dummy_card_front_back"].includes(documentKind) ||
            (documentKind === "dummy_card_front_back" && fileType !== "png")) {
          return res.status(400).json({
            error: "Choose a valid PDF/JPG/PNG sample (max 2 MB), copies and print mode"
          });
        }

        let storedKey = null;
        try {
          const shop = await pool.query(
            "SELECT id FROM shops WHERE public_code = $1",
            [code]
          );
          if (!shop.rows.length) {
            return res.status(404).json({ error: "Shop not found" });
          }
          const shopId = shop.rows[0].id;

          // Small bounded test quota. The rate limiter additionally controls
          // repeat submissions; this quota is not a transactional billing limit.
          const count = await pool.query(
            "SELECT COUNT(*)::int AS total FROM test_file_orders WHERE shop_id = $1",
            [shopId]
          );
          if (count.rows[0].total >= 10) {
            return res.status(429).json({
              error: "This shop has reached its test storage limit (10 files)"
            });
          }

          storedKey = "test-uploads/" + shopId + "/" + randomUUID() +
            "." + (fileType === "jpeg" ? "jpg" : fileType);
          const checksum = createHash("sha256").update(req.file.buffer).digest("hex");
          const trackingToken = randomBytes(24).toString("hex");
          const trackingTokenHash = trackingHash(trackingToken);

          await storage.send(new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: storedKey,
            Body: req.file.buffer,
            ContentType: allowedTypes[fileType],
            CacheControl: "private, no-store"
          }));

          const result = await pool.query(
            `INSERT INTO test_file_orders
              (shop_id, customer_id, storage_key, file_type,
               file_size_bytes, file_sha256, copies, print_mode, tracking_token_hash, document_kind)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id, status, created_at AS "createdAt"`,
            [shopId, (req.session && req.session.userId) || null, storedKey, fileType,
              req.file.size, checksum, copies, printMode, trackingTokenHash, documentKind]
          );

          return res.status(201).json({
            testOnly: true,
            message: "Private TEST file stored. Shop owner review required. No automatic printing or charge.",
            guest: !(req.session && req.session.userId),
            order: result.rows[0],
            trackingToken
          });
        } catch (error) {
          console.error("Private test upload failed:", error);
          if (storedKey) {
            try {
              await storage.send(new DeleteObjectCommand({
                Bucket: cfg.bucket, Key: storedKey
              }));
            } catch (cleanupError) {
              console.error("Test upload cleanup failed:", cleanupError);
            }
          }
          return res.status(503).json({ error: "Test upload was not completed" });
        }
      });
    }
  );

  // Status-only lookup does not reveal the uploaded file or identity.
  app.post("/api/public/shops/:code/test-file-orders/status",
    trackLimiter, async (req, res) => {
      const code = req.params.code;
      const { orderId, trackingToken } = req.body || {};
      const hash = trackingHash(trackingToken);
      if (!/^[a-f0-9]{32}$/.test(code || "") ||
          !/^[1-9][0-9]{0,14}$/.test(String(orderId || "")) || !hash) {
        return res.status(400).json({ error: "Enter a valid test order ID and tracking code" });
      }
      try {
        const result = await pool.query(
          `SELECT o.id, o.status, o.created_at AS "createdAt"
           FROM test_file_orders o JOIN shops s ON s.id = o.shop_id
           WHERE s.public_code = $1 AND o.id = $2 AND o.tracking_token_hash = $3`,
          [code, String(orderId), hash]
        );
        res.set("Cache-Control", "no-store");
        if (!result.rows.length) return res.status(404).json({ error: "Tracking details not found" });
        return res.json({ testOnly: true, order: result.rows[0] });
      } catch (error) {
        console.error("Private test order status lookup failed:", error);
        return res.status(503).json({ error: "Could not check test order status" });
      }
    }
  );
  // The owner must accept a sample before confirming printed paper.
  app.post("/api/shop/test-file-orders/:id/decision",
    requireShopOwner, async (req, res) => {
      if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "") ||
          !["accepted", "rejected"].includes(req.body?.decision)) {
        return res.status(400).json({ error: "Select Accept or Reject for a valid order" });
      }
      try {
        const result = await pool.query(
          `UPDATE test_file_orders o SET status = $3
           FROM shop_owners owner
           WHERE owner.shop_id = o.shop_id AND owner.id = $1 AND o.id = $2
             AND o.status = 'test_only'
             AND o.created_at > NOW() - INTERVAL '24 hours'
           RETURNING o.id, o.status`,
          [req.session.shopOwnerId, req.params.id, req.body.decision]
        );
        if (!result.rows.length) return res.status(409).json({
          error: "Order is not pending, is expired, or does not belong to this shop"
        });
        res.set("Cache-Control", "private, no-store");
        return res.json({ testOnly: true, order: result.rows[0] });
      } catch (error) {
        console.error("Private test order decision failed:", error);
        return res.status(503).json({ error: "Could not update order" });
      }
    }
  );

  app.get("/api/customer/test-file-orders", requireCustomer, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT o.id, s.name AS "shopName", o.file_type AS "fileType",
                o.file_size_bytes AS "fileSizeBytes",
                o.copies, o.print_mode AS "printMode", o.status,
                o.created_at AS "createdAt"
         FROM test_file_orders o
         JOIN shops s ON s.id = o.shop_id
         WHERE o.customer_id = $1
         ORDER BY o.created_at DESC, o.id DESC LIMIT 20`,
        [req.session.userId]
      );
      res.set("Cache-Control", "no-store");
      res.json({ testOnly: true, orders: result.rows });
    } catch (error) {
      console.error("Customer test orders error:", error);
      res.status(503).json({ error: "Unable to load test orders" });
    }
  });

  app.get("/api/shop/test-file-orders", requireShopOwner, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT o.id, o.document_kind AS "documentKind", o.file_type AS "fileType",
                o.file_size_bytes AS "fileSizeBytes", o.copies,
                o.print_mode AS "printMode", o.status,
                o.created_at AS "createdAt"
         FROM test_file_orders o
         JOIN shop_owners owner ON owner.shop_id = o.shop_id
         WHERE owner.id = $1
         ORDER BY o.created_at DESC, o.id DESC LIMIT 20`,
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      res.json({ testOnly: true, orders: result.rows });
    } catch (error) {
      console.error("Shop test file orders error:", error);
      res.status(503).json({ error: "Unable to load test file orders" });
    }
  });

  // An owner confirms status only AFTER verifying physical paper output.
  // A browser print dialog closing is not evidence of successful printing.
  app.post("/api/shop/test-file-orders/:id/mark-printed",
    requireShopOwner, async (req, res) => {
      if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
        return res.status(400).json({ error: "Invalid order id" });
      }
      const expectedOrigin = req.protocol + "://" + req.get("host");
      if (req.get("origin") !== expectedOrigin) {
        return res.status(403).json({ error: "Request origin not allowed" });
      }
      if (!req.body || req.body.confirmedPaperOutput !== true) {
        return res.status(400).json({ error: "Confirm that the paper was printed" });
      }
      try {
        const result = await pool.query(
          `UPDATE test_file_orders o SET status = 'printed'
           FROM shop_owners owner
           WHERE owner.shop_id = o.shop_id AND owner.id = $1
             AND o.id = $2 AND o.status = 'accepted'
             AND o.created_at > NOW() - INTERVAL '24 hours'
           RETURNING o.id, o.status`,
          [req.session.shopOwnerId, req.params.id]
        );
        if (!result.rows.length) {
          return res.status(404).json({ error: "Order not accepted, not yours, or test file expired" });
        }
        res.set("Cache-Control", "no-store");
        return res.json({ testOnly: true, order: result.rows[0] });
      } catch (error) {
        console.error("Mark printed status failed:", error);
        return res.status(503).json({ error: "Could not update order status" });
      }
    }
  );

  app.get("/api/shop/test-file-orders/:id/download",
    requireShopOwner, async (req, res) => {
      if (!storage) {
        return res.status(503).json({ error: "Private storage is not configured" });
      }
      if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
        return res.status(400).json({ error: "Invalid order id" });
      }
      try {
        const result = await pool.query(
          `SELECT o.id, o.storage_key, o.file_type, o.file_size_bytes,
                  o.file_sha256, o.created_at
           FROM test_file_orders o
           JOIN shop_owners owner ON owner.shop_id = o.shop_id
           WHERE owner.id = $1 AND o.id = $2
             AND o.status IN ('test_only','accepted','printed')
             AND o.created_at > NOW() - INTERVAL '24 hours'
             AND o.file_deleted_at IS NULL`,
          [req.session.shopOwnerId, req.params.id]
        );
        if (!result.rows.length) {
          return res.status(404).json({
            error: "Order not found, not yours, or test file expired"
          });
        }

        const record = result.rows[0];
        const object = await storage.send(new GetObjectCommand({
          Bucket: cfg.bucket, Key: record.storage_key
        }));
        if (Number(object.ContentLength) > MAX_FILE_BYTES) {
          if (object.Body && typeof object.Body.destroy === "function") object.Body.destroy();
          return res.status(503).json({ error: "Unexpected stored file size" });
        }
        const bytes = Buffer.from(await object.Body.transformToByteArray());
        if (bytes.length !== record.file_size_bytes ||
            createHash("sha256").update(bytes).digest("hex") !== record.file_sha256) {
          return res.status(503).json({ error: "Test file integrity check failed" });
        }

        const ext = record.file_type === "jpeg" ? "jpg" : record.file_type;
        res.set({
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "sandbox",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'attachment; filename="test-order-' + record.id + "." + ext + '"'
        });
        return res.type("application/octet-stream").send(bytes);
      } catch (error) {
        console.error("Test file download failed:", error);
        return res.status(503).json({ error: "Unable to download test file" });
      }
    }
  );

  app.delete("/api/shop/test-file-orders/:id", requireShopOwner,
    async (req, res) => {
      if (!storage) return res.status(503).json({ error: "Storage not configured" });
      if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
        return res.status(400).json({ error: "Invalid order id" });
      }
      try {
        const result = await pool.query(
          `SELECT o.storage_key
           FROM test_file_orders o
           JOIN shop_owners owner ON owner.shop_id = o.shop_id
           WHERE owner.id = $1 AND o.id = $2`,
          [req.session.shopOwnerId, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: "Not found" });
        await storage.send(new DeleteObjectCommand({
          Bucket: cfg.bucket, Key: result.rows[0].storage_key
        }));
        await pool.query(
          `DELETE FROM test_file_orders
           WHERE id = $1 AND shop_id IN
             (SELECT shop_id FROM shop_owners WHERE id = $2)`,
          [req.params.id, req.session.shopOwnerId]
        );
        res.set("Cache-Control", "no-store");
        return res.json({ deleted: true, testOnly: true });
      } catch (error) {
        console.error("Test file deletion failed:", error);
        return res.status(503).json({ error: "Unable to delete test file" });
      }
    }
  );
}

module.exports = {
  installTestFileUploads, ensureTestUploadTables,
  storageSettings, guestTestUploadsEnabled, detectSafeFile, MAX_FILE_BYTES,
  purgeExpiredTestFiles
};
