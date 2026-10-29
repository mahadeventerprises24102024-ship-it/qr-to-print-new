"use strict";

// OWNER-APPROVED, OPT-IN, SMALL TEST FILES ONLY. This is not production printing.
// A guest upload never automatically becomes a print job.
const { randomBytes, createHash } = require("node:crypto");
const rateLimit = require("express-rate-limit");
const {
  S3Client, GetObjectCommand
} = require("@aws-sdk/client-s3");
const {
  storageSettings, detectSafeFile, MAX_FILE_BYTES
} = require("./private-test-uploads");

const KEY_RE = /^qrpa_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[1-9][0-9]{0,14}$/;
const MAX_TEST_COPIES = 2;
const approveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 6,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many test print requests. Try later." }
});

function enabled(env = process.env) {
  return env.ENABLE_OWNER_APPROVED_TEST_PRINTS === "true" &&
    storageSettings(env).enabled;
}

function requireOwner(req, res, next) {
  if (!req.session || !req.session.shopOwnerId) {
    return res.status(401).json({ error: "Shop owner login required" });
  }
  next();
}

function agentToken(req) {
  if (req.get("origin")) return null;
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return KEY_RE.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

function storageClient(cfg) {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: "auto",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey
    }
  });
}

async function ensureApprovedPrintTables(pool) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS approved_test_print_jobs (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE, " +
    "order_id BIGINT NOT NULL UNIQUE REFERENCES test_file_orders(id) ON DELETE CASCADE, " +
    "status VARCHAR(16) NOT NULL DEFAULT 'queued' " +
      "CHECK (status IN ('queued','claimed','submitted','failed','expired')), " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "claimed_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)"
  );
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS approved_test_one_active_per_shop " +
    "ON approved_test_print_jobs(shop_id) WHERE status IN ('queued','claimed')"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS approved_test_shop_history " +
    "ON approved_test_print_jobs(shop_id, id DESC)"
  );
}

async function expire(pool, shopId) {
  await pool.query(
    "UPDATE approved_test_print_jobs SET status='expired', finished_at=NOW() " +
    "WHERE shop_id=$1 AND " +
    "((status='queued' AND created_at < NOW() - INTERVAL '3 minutes') OR " +
    "(status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'))",
    [shopId]
  );
}

function installApprovedTestPrintApis(app, pool, env = process.env) {
  const cfg = storageSettings(env);
  const active = enabled(env);
  const storage = active ? storageClient(cfg) : null;

  app.get("/api/shop/approved-test-print/status", requireOwner, async (req, res) => {
    try {
      const jobs = await pool.query(
        "SELECT j.id, j.order_id AS \"orderId\", j.status, " +
        "j.created_at AS \"createdAt\", j.finished_at AS \"finishedAt\" " +
        "FROM approved_test_print_jobs j " +
        "JOIN shop_owners o ON o.shop_id=j.shop_id " +
        "WHERE o.id=$1 ORDER BY j.id DESC LIMIT 30",
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      res.json({ enabled: active, testOnly: true, customerPrintAutomation: false,
        maxCopies: MAX_TEST_COPIES, pdfMaxPages: 2, jobs: jobs.rows });
    } catch (error) {
      console.error("Approved test print status failed:", error);
      res.status(503).json({ error: "Test print status unavailable" });
    }
  });

  app.post("/api/shop/approved-test-print/:orderId",
    requireOwner, approveLimiter, async (req, res) => {
      if (!active) return res.status(503).json({
        error: "Owner-approved test printing is disabled in Render"
      });
      if (!ID_RE.test(req.params.orderId || "") ||
          !req.body || req.body.reviewed !== true) {
        return res.status(400).json({
          error: "Review the file and explicitly approve the print first"
        });
      }
      try {
        const record = await pool.query(
          "SELECT f.id, f.shop_id, f.file_type, f.copies " +
          "FROM test_file_orders f " +
          "JOIN shop_owners o ON o.shop_id=f.shop_id " +
          "JOIN shop_print_agents a ON a.shop_id=f.shop_id " +
          "WHERE o.id=$1 AND f.id=$2 " +
          "AND f.created_at > NOW()-INTERVAL '24 hours' " +
          "AND f.file_size_bytes BETWEEN 8 AND 2097152 " +
          "AND a.last_seen_at > NOW()-INTERVAL '100 seconds' AND a.supports_approved_test_print=TRUE",
          [req.session.shopOwnerId, req.params.orderId]
        );
        if (!record.rows.length) return res.status(409).json({
          error: "File expired, unavailable, or updated Windows agent not online"
        });
        const file = record.rows[0];
        if (!["pdf","png","jpeg"].includes(file.file_type) ||
            !Number.isInteger(Number(file.copies)) ||
            Number(file.copies) < 1 || Number(file.copies) > MAX_TEST_COPIES) {
          return res.status(400).json({
            error: "For a safe first test, upload a PDF/photo with only 1 or 2 copies"
          });
        }
        await expire(pool, file.shop_id);
        const quota = await pool.query(
          "SELECT COUNT(*)::integer AS total FROM approved_test_print_jobs " +
          "WHERE shop_id=$1 AND created_at > NOW()-INTERVAL '1 hour'",
          [file.shop_id]
        );
        if (quota.rows[0].total >= 3) return res.status(429).json({
          error: "Maximum 3 owner-approved test jobs per hour"
        });
        const created = await pool.query(
          "INSERT INTO approved_test_print_jobs(shop_id,order_id) " +
          "VALUES ($1,$2) RETURNING id,status",
          [file.shop_id, file.id]
        );
        res.set("Cache-Control", "no-store");
        return res.status(201).json({
          testOnly: true, message: "One owner-approved test file queued once",
          job: created.rows[0]
        });
      } catch (error) {
        if (error.code === "23505") return res.status(409).json({
          error: "This file was already approved or another test job is pending. Never retry automatically."
        });
        console.error("Approved test print request failed:", error);
        return res.status(503).json({ error: "Could not approve this test print" });
      }
    }
  );

  // Bearer token maps to one paired shop. No shop cookies, public URLs or
  // presigned R2 links. File downloads require a previously claimed job.
  app.get("/api/agent/approved-test-print/:jobId/file", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const hash = agentToken(req);
    if (!active || !storage) return res.status(503).json({ error: "Printing disabled" });
    if (!hash || !ID_RE.test(req.params.jobId || "")) {
      return res.status(401).json({ error: "Invalid agent authentication" });
    }
    try {
      const records = await pool.query(
        "SELECT f.storage_key, f.file_type, f.file_size_bytes, f.file_sha256, " +
        "j.id FROM approved_test_print_jobs j " +
        "JOIN test_file_orders f ON f.id=j.order_id AND f.shop_id=j.shop_id " +
        "JOIN shop_print_agents a ON a.shop_id=j.shop_id " +
        "WHERE a.token_hash=$1 AND j.id=$2 AND j.status='claimed' " +
        "AND j.claimed_at > NOW()-INTERVAL '5 minutes' " +
        "AND f.created_at > NOW()-INTERVAL '24 hours'",
        [hash, req.params.jobId]
      );
      if (!records.rows.length) return res.status(404).json({
        error: "Print job unavailable or revoked"
      });
      const f = records.rows[0];
      if (!["pdf","png","jpeg"].includes(f.file_type) ||
          !Number.isInteger(Number(f.file_size_bytes)) ||
          f.file_size_bytes < 8 || f.file_size_bytes > MAX_FILE_BYTES) {
        return res.status(503).json({ error: "Invalid file metadata" });
      }
      const object = await storage.send(new GetObjectCommand({
        Bucket: cfg.bucket, Key: f.storage_key
      }));
      if (Number(object.ContentLength) > MAX_FILE_BYTES) {
        if (object.Body && typeof object.Body.destroy === "function") object.Body.destroy();
        return res.status(503).json({ error: "File too large" });
      }
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      const ext = f.file_type === "jpeg" ? "jpg" : f.file_type;
      const valid = detectSafeFile({
        buffer: bytes,
        mimetype: ({ pdf:"application/pdf",png:"image/png",jpeg:"image/jpeg" })[f.file_type],
        originalname: "sample." + ext
      });
      if (bytes.length !== f.file_size_bytes || valid !== f.file_type ||
          createHash("sha256").update(bytes).digest("hex") !== f.file_sha256) {
        return res.status(503).json({ error: "Private test file verification failed" });
      }
      res.set({
        "Cache-Control": "private, no-store",
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=approved-test-file.bin",
        "X-Content-Type-Options": "nosniff",
        "X-Test-File-Type": f.file_type,
        "X-Test-File-SHA256": f.file_sha256
      });
      return res.send(bytes);
    } catch (error) {
      console.error("Approved test file access failed:", error);
      return res.status(503).json({ error: "File unavailable for approved test print" });
    }
  });
}

async function processAgentApprovedHeartbeat(pool, shopId, supports, ack, env = process.env) {
  if (!enabled(env) || supports !== true) return null;
  // Acknowledgments never relaunch printing. Each job is claimed once.
  if (ack != null) {
    const id = String(ack.id || "");
    if (!ID_RE.test(id) || !["submitted","failed"].includes(ack.status)) {
      throw new Error("Invalid approved print acknowledgment");
    }
    await pool.query(
      "UPDATE approved_test_print_jobs " +
      "SET status=$3, finished_at=NOW() " +
      "WHERE id=$1 AND shop_id=$2 AND status='claimed'",
      [id, shopId, ack.status]
    );
  }
  await expire(pool, shopId);
  const claim = await pool.query(
    "UPDATE approved_test_print_jobs j " +
    "SET status='claimed', claimed_at=NOW() " +
    "FROM test_file_orders f " +
    "WHERE j.id=(SELECT id FROM approved_test_print_jobs " +
       "WHERE shop_id=$1 AND status='queued' ORDER BY id " +
       "FOR UPDATE SKIP LOCKED LIMIT 1) " +
    "AND j.order_id=f.id AND f.created_at > NOW()-INTERVAL '24 hours' " +
    "RETURNING j.id, f.file_type AS \"fileType\", " +
    "f.file_size_bytes AS \"fileBytes\", f.file_sha256 AS \"sha256\", " +
    "f.print_mode AS \"printMode\", f.copies",
    [shopId]
  );
  if (!claim.rows.length) return null;
  const job = claim.rows[0];
  if (!["pdf","png","jpeg"].includes(job.fileType) ||
      !Number.isInteger(Number(job.copies)) || job.copies < 1 ||
      job.copies > MAX_TEST_COPIES ||
      !Number.isInteger(Number(job.fileBytes)) ||
      job.fileBytes < 8 || job.fileBytes > MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(job.sha256)) {
    // Claim remains non-retriable until expiry. Never send malformed jobs.
    return null;
  }
  return {
    kind: "approved_private_test_file", id: String(job.id),
    fileType: job.fileType, fileBytes: Number(job.fileBytes),
    sha256: job.sha256, copies: Number(job.copies),
    printMode: job.printMode, pdfMaxPages: 2
  };
}

module.exports = { enabled, ensureApprovedPrintTables,
  installApprovedTestPrintApis, processAgentApprovedHeartbeat, agentToken };
