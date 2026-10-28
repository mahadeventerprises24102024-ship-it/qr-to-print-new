"use strict";
const rateLimit = require("express-rate-limit");

const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

async function ensureDemoOrderTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_print_requests (
      id BIGSERIAL PRIMARY KEY,
      shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      file_type VARCHAR(8) NOT NULL CHECK (file_type IN ('pdf', 'png', 'jpeg')),
      file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
      copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 10),
      status VARCHAR(16) NOT NULL DEFAULT 'demo_only',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS demo_print_requests_shop_recent
    ON demo_print_requests (shop_id, created_at DESC)
  `);
}
function installDemoOrderApis(app, pool) {
  app.post("/api/public/shops/:code/demo-orders", demoLimiter, async (req, res) => {
    const code = req.params.code;
    const { fileType, fileSizeBytes, copies } = req.body || {};
    if (!/^[a-f0-9]{32}$/.test(code || "") ||
        !["pdf", "png", "jpeg"].includes(fileType) ||
        !Number.isInteger(fileSizeBytes) || fileSizeBytes < 1 ||
        fileSizeBytes > 10485760 ||
        !Number.isInteger(copies) || copies < 1 || copies > 10) {
      return res.status(400).json({ error: "Invalid test request" });
    }
    try {
      const found = await pool.query("SELECT id FROM shops WHERE public_code = $1", [code]);
      if (!found.rows.length) return res.status(404).json({ error: "Shop not found" });
      const count = await pool.query(
        "SELECT COUNT(*)::int AS total FROM demo_print_requests WHERE shop_id = $1",
        [found.rows[0].id]
      );
      if (count.rows[0].total >= 30) {
        return res.status(429).json({ error: "Demo limit reached" });
      }
      const result = await pool.query(
        `INSERT INTO demo_print_requests
         (shop_id, file_type, file_size_bytes, copies)
         VALUES ($1, $2, $3, $4)
         RETURNING id, status, created_at AS "createdAt"`,
        [found.rows[0].id, fileType, fileSizeBytes, copies]
      );
      return res.status(201).json({
        demoOnly: true,
        fileUploaded: false,
        message: "Test request saved, not uploaded or printed.",
        order: result.rows[0]
      });
    } catch (error) {
      console.error("Demo order failed:", error);
      return res.status(503).json({ error: "Unable to save test request" });
    }
  });
  app.get("/api/shop/demo-orders", async (req, res) => {
    if (!req.session || !req.session.shopOwnerId) {
      return res.status(401).json({ error: "Shop login required" });
    }
    try {
      const orders = await pool.query(
        `SELECT r.id, r.file_type AS "fileType", r.file_size_bytes AS "fileSizeBytes",
                r.copies, r.status, r.created_at AS "createdAt"
         FROM demo_print_requests r
         JOIN shop_owners owner ON owner.shop_id = r.shop_id
         WHERE owner.id = $1
         ORDER BY r.created_at DESC, r.id DESC LIMIT 30`,
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      return res.json({ demoOnly: true, orders: orders.rows });
    } catch (error) {
      console.error("Demo orders lookup failed:", error);
      return res.status(503).json({ error: "Unable to load test requests" });
    }
  });
}
module.exports = { ensureDemoOrderTables, installDemoOrderApis };
