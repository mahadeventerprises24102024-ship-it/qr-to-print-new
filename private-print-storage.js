"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2, parts: 3 }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many uploads. Try again later." }
});

function readStorageSettings(env = process.env) {
  if (env.PRIVATE_UPLOADS_ENABLED !== "true") {
    return { enabled: false, reason: "Private file storage has not been enabled." };
  }

  const required = [
    "PRIVATE_STORAGE_BUCKET", "PRIVATE_STORAGE_ENDPOINT",
    "PRIVATE_STORAGE_ACCESS_KEY_ID", "PRIVATE_STORAGE_SECRET_ACCESS_KEY"
  ];
  if (env.PRIVATE_STORAGE_RETENTION_CONFIRMED !== "true" ||
      required.some(key => !env[key])) {
    return { enabled: false, reason: "Private storage or its 1-day lifecycle rule is not configured." };
  }

  try {
    const endpoint = new URL(env.PRIVATE_STORAGE_ENDPOINT);
    if (endpoint.protocol !== "https:" || endpoint.username ||
        endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.pathname !== "/") {
      throw new Error("Invalid storage endpoint");
    }
  } catch {
    return { enabled: false, reason: "Private storage endpoint must be an HTTPS origin." };
  }

  return {
    enabled: true, bucket: env.PRIVATE_STORAGE_BUCKET,
    endpoint: env.PRIVATE_STORAGE_ENDPOINT,
    region: env.PRIVATE_STORAGE_REGION || "auto",
    accessKeyId: env.PRIVATE_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.PRIVATE_STORAGE_SECRET_ACCESS_KEY
  };
}

let cachedClient;
function storageClient(config) {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      maxAttempts: 2
    });
  }
  return cachedClient;
}

function detectAllowedFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer) ||
      file.size < 12 || file.size > MAX_FILE_BYTES) return null;
  const bytes = file.buffer;
  const extension = path.extname(file.originalname || "").toLowerCase();

  if (extension === ".pdf" &&
      bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { type: "pdf", mime: "application/pdf", extension: "pdf" };
  }
  if (extension === ".png" && bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    return { type: "png", mime: "image/png", extension: "png" };
  }
  if ([".jpg", ".jpeg"].includes(extension) &&
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { type: "jpeg", mime: "image/jpeg", extension: "jpg" };
  }
  return null;
}

function requireCustomer(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Customer login is required to upload files." });
  }
  next();
}
function requireOwner(req, res, next) {
  if (!req.session || !req.session.shopOwnerId) {
    return res.status(401).json({ error: "Shop-owner login required." });
  }
  next();
}
function requireStorage(req, res, next) {
  const config = readStorageSettings();
  if (!config.enabled) return res.status(503).json({ error: config.reason });
  res.locals.privateStorageConfig = config;
  next();
}

async function ensurePrivatePrintTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_print_orders (
      id UUID PRIMARY KEY,
      shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      file_type VARCHAR(8) NOT NULL CHECK (file_type IN ('pdf','png','jpeg')),
      file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes BETWEEN 12 AND 5242880),
      copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 10),
      color_mode VARCHAR(12) NOT NULL CHECK (color_mode IN ('bw','color')),
      status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review','reviewed','completed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS private_print_orders_shop_recent
      ON private_print_orders(shop_id, created_at DESC)
  `);
}

function installPrivatePrintRoutes(app, pool) {
  app.get("/api/private-print/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      enabled: readStorageSettings().enabled,
      customerLoginRequired: true,
      maxBytes: MAX_FILE_BYTES,
      retentionHours: 24
    });
  });

  app.post(
    "/api/public/shops/:code/private-orders",
    requireCustomer, requireStorage, uploadLimiter,
    (req, res) => upload.single("file")(req, res, async err => {
      if (err) {
        return res.status(err instanceof multer.MulterError ? 413 : 400)
          .json({ error: "Invalid file upload. Maximum file size is 5 MB." });
      }

      const code = req.params.code;
      const copies = Number(req.body && req.body.copies);
      const colorMode = req.body && req.body.colorMode;
      const kind = detectAllowedFile(req.file);

      if (!/^[a-f0-9]{32}$/.test(code || "") ||
          !kind || !Number.isInteger(copies) ||
          copies < 1 || copies > 10 ||
          !["bw", "color"].includes(colorMode)) {
        return res.status(400).json({
          error: "Select a genuine PDF, JPG, or PNG file (max 5 MB), 1–10 copies, and a color mode."
        });
      }

      const config = res.locals.privateStorageConfig;
      let key;
      try {
        const shopResult = await pool.query(
          "SELECT id FROM shops WHERE public_code = $1", [code]
        );
        if (!shopResult.rows.length) {
          return res.status(404).json({ error: "Shop not found" });
        }
        const shopId = shopResult.rows[0].id;

        const recent = await pool.query(
          `SELECT COUNT(*)::int AS total FROM private_print_orders
           WHERE shop_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
          [shopId]
        );
        if (recent.rows[0].total >= 25) {
          return res.status(429).json({
            error: "Daily test upload limit reached for this shop."
          });
        }

        const orderId = randomUUID();
        key = "private-print/" + shopId + "/" + orderId + "." + kind.extension;
        const client = storageClient(config);

        // Never log, publish, or expose the original filename or file bytes.
        await client.send(new PutObjectCommand({
          Bucket: config.bucket, Key: key, Body: req.file.buffer,
          ContentType: kind.mime,
          ContentDisposition: "attachment",
          CacheControl: "no-store"
        }));

        const result = await pool.query(
          `INSERT INTO private_print_orders
             (id, shop_id, customer_id, storage_key, file_type,
              file_size_bytes, copies, color_mode, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   NOW() + INTERVAL '24 hours')
           RETURNING id, status, created_at AS "createdAt"`,
          [orderId, shopId, req.session.userId, key,
           kind.type, req.file.size, copies, colorMode]
        );

        return res.status(201).json({
          order: result.rows[0],
          message: "Private file received for manual review. No automatic printing or payment has occurred.",
          printed: false
        });
      } catch (error) {
        // Compensating deletion when metadata insert fails after upload.
        if (key) {
          try {
            await storageClient(config).send(new DeleteObjectCommand({
              Bucket: config.bucket, Key: key
            }));
          } catch (cleanupError) {
            console.error("Private object cleanup failed:", cleanupError.name);
          }
        }
        console.error("Private print upload failed:", error.name);
        return res.status(503).json({ error: "Secure upload failed. Please try again." });
      }
    })
  );

  app.get("/api/shop/private-orders",
    requireOwner, requireStorage, async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT p.id, p.file_type AS "fileType",
                  p.file_size_bytes AS "fileSizeBytes",
                  p.copies, p.color_mode AS "colorMode",
                  p.status, p.created_at AS "createdAt",
                  p.expires_at AS "expiresAt",
                  c.name AS "customerName"
           FROM private_print_orders p
           JOIN shop_owners o ON o.shop_id = p.shop_id
           JOIN customers c ON c.id = p.customer_id
           WHERE o.id = $1
           ORDER BY p.created_at DESC LIMIT 50`,
          [req.session.shopOwnerId]
        );
        res.set("Cache-Control", "no-store");
        return res.json({ orders: result.rows, printingConnected: false });
      } catch (error) {
        console.error("Private print list failed:", error.name);
        return res.status(503).json({ error: "Could not load private orders." });
      }
    }
  );

  app.get("/api/shop/private-orders/:id/file",
    requireOwner, requireStorage, async (req, res) => {
      if (!/^[a-f0-9-]{36}$/.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid order ID." });
      }

      try {
        const result = await pool.query(
          `SELECT p.storage_key, p.file_type, p.file_size_bytes
           FROM private_print_orders p
           JOIN shop_owners o ON o.shop_id = p.shop_id
           WHERE p.id = $1 AND o.id = $2
             AND p.expires_at > NOW()`,
          [req.params.id, req.session.shopOwnerId]
        );
        if (!result.rows.length) {
          return res.status(404).json({ error: "File unavailable or expired." });
        }
        const order = result.rows[0];
        const config = res.locals.privateStorageConfig;
        const response = await storageClient(config).send(new GetObjectCommand({
          Bucket: config.bucket, Key: order.storage_key
        }));
        if (response.ContentLength && response.ContentLength > MAX_FILE_BYTES) {
          return res.status(503).json({ error: "Stored file exceeds the allowed size." });
        }
        const body = Buffer.from(await response.Body.transformToByteArray());
        if (body.length > MAX_FILE_BYTES) {
          return res.status(503).json({ error: "Stored file exceeds the allowed size." });
        }

        const ext = { pdf: "pdf", jpeg: "jpg", png: "png" }[order.file_type];
        res.set({
          "Cache-Control": "private, no-store",
          "Content-Disposition": 'attachment; filename="print-order-' + req.params.id + '.' + ext + '"',
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox"
        });
        res.type("application/octet-stream");
        return res.send(body);
      } catch (error) {
        console.error("Private file download failed:", error.name);
        return res.status(503).json({ error: "Could not download private file." });
      }
    }
  );

  // Shop owners can remove individual document objects and their metadata.
  app.delete("/api/shop/private-orders/:id",
    requireOwner, requireStorage, async (req, res) => {
      if (!/^[a-f0-9-]{36}$/.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid order ID." });
      }
      try {
        const result = await pool.query(
          `SELECT p.storage_key FROM private_print_orders p
           JOIN shop_owners o ON o.shop_id = p.shop_id
           WHERE p.id = $1 AND o.id = $2`,
          [req.params.id, req.session.shopOwnerId]
        );
        if (!result.rows.length) {
          return res.status(404).json({ error: "Order not found." });
        }
        const config = res.locals.privateStorageConfig;
        await storageClient(config).send(new DeleteObjectCommand({
          Bucket: config.bucket, Key: result.rows[0].storage_key
        }));
        await pool.query(
          `DELETE FROM private_print_orders p USING shop_owners o
           WHERE p.id = $1 AND p.shop_id = o.shop_id AND o.id = $2`,
          [req.params.id, req.session.shopOwnerId]
        );
        return res.json({ message: "Document and order metadata deleted." });
      } catch (error) {
        console.error("Private order deletion failed:", error.name);
        return res.status(503).json({ error: "Could not delete this order." });
      }
    }
  );
}

module.exports = {
  installPrivatePrintRoutes,
  ensurePrivatePrintTables,
  readStorageSettings,
  detectAllowedFile
};
