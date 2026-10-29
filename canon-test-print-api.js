"use strict";

// Explicit, single-page Canon G2010 TEST ONLY.
// No uploaded/customer files or user-supplied print payloads are ever sent.
const rateLimit = require("express-rate-limit");
const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 6,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many test print attempts. Try again later." }
});

function canonTestPrintEnabled(env = process.env) {
  return env.ENABLE_CANON_TEST_PRINT === "true";
}

async function ensureCanonTestPrintTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canon_test_print_jobs (
      id BIGSERIAL PRIMARY KEY,
      shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','claimed','submitted','failed','expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS canon_test_one_active_per_shop
    ON canon_test_print_jobs(shop_id)
    WHERE status IN ('queued', 'claimed')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS canon_test_shop_history
    ON canon_test_print_jobs(shop_id, id DESC)
  `);
}

function requireShopOwner(req, res, next) {
  if (!req.session || !req.session.shopOwnerId) {
    return res.status(401).json({ error: "Shop login required" });
  }
  next();
}

async function expireOldJobs(pool, shopId) {
  await pool.query(
    `UPDATE canon_test_print_jobs
     SET status = 'expired', finished_at = NOW()
     WHERE shop_id = $1 AND
       ((status = 'queued' AND created_at < NOW() - INTERVAL '5 minutes')
       OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '10 minutes'))`,
    [shopId]
  );
}

function installCanonTestPrintApis(app, pool) {
  app.get("/api/shop/canon-test-print/status", requireShopOwner, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT j.id, j.status, j.created_at AS "createdAt",
                j.finished_at AS "finishedAt"
         FROM canon_test_print_jobs j
         JOIN shop_owners o ON o.shop_id = j.shop_id
         WHERE o.id = $1
         ORDER BY j.id DESC LIMIT 3`,
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      res.json({
        enabled: canonTestPrintEnabled(),
        onlyFixedTestPage: true,
        customerPrintingEnabled: false,
        jobs: result.rows
      });
    } catch (error) {
      console.error("Canon test print status failed:", error);
      res.status(503).json({ error: "Unable to load test print status" });
    }
  });

  app.post("/api/shop/canon-test-print/request",
    requireShopOwner, requestLimiter, async (req, res) => {
      if (!canonTestPrintEnabled()) {
        return res.status(503).json({
          error: "Canon test printing is disabled. Enable it explicitly in Render first."
        });
      }
      try {
        const owner = await pool.query(
          `SELECT o.shop_id AS "shopId"
           FROM shop_owners o
           JOIN shop_print_agents a ON a.shop_id = o.shop_id
           WHERE o.id = $1 AND a.last_seen_at > NOW() - INTERVAL '100 seconds'`,
          [req.session.shopOwnerId]
        );
        if (!owner.rows.length) {
          return res.status(409).json({ error: "Connect your Windows Agent before requesting a test page" });
        }
        const shopId = owner.rows[0].shopId;
        await expireOldJobs(pool, shopId);
        const count = await pool.query(
          `SELECT COUNT(*)::integer AS total
           FROM canon_test_print_jobs
           WHERE shop_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
          [shopId]
        );
        if (count.rows[0].total >= 5) {
          return res.status(429).json({ error: "Limit of 5 test pages per hour reached" });
        }
        const job = await pool.query(
          `INSERT INTO canon_test_print_jobs(shop_id)
           VALUES ($1) RETURNING id, status`,
          [shopId]
        );
        res.set("Cache-Control", "no-store");
        return res.status(201).json({
          testOnly: true,
          message: "One fixed Canon G2010 test page queued. No customer document involved.",
          job: job.rows[0]
        });
      } catch (error) {
        if (error.code === "23505") {
          return res.status(409).json({
            error: "A test print is already queued or in progress"
          });
        }
        console.error("Canon test print request failed:", error);
        return res.status(503).json({ error: "Unable to queue Canon test print" });
      }
    }
  );
}

// Invoked only after validating the paired agent's bearer token.
// Atomic claim prevents repeat delivery if a heartbeat is retried.
async function handleCanonTestHeartbeat(pool, shopId, acknowledgment, env = process.env) {
  if (!canonTestPrintEnabled(env)) return null;
  await expireOldJobs(pool, shopId);

  if (acknowledgment != null) {
    const id = String(acknowledgment.id || "");
    const result = acknowledgment.status;
    if (!/^[1-9][0-9]{0,14}$/.test(id) ||
        !["submitted", "failed"].includes(result)) {
      throw new Error("Invalid test print acknowledgment");
    }
    await pool.query(
      `UPDATE canon_test_print_jobs
       SET status = $3, finished_at = NOW()
       WHERE id = $1 AND shop_id = $2 AND status = 'claimed'`,
      [id, shopId, result]
    );
  }

  const result = await pool.query(
    `UPDATE canon_test_print_jobs
     SET status = 'claimed', claimed_at = NOW()
     WHERE id = (
       SELECT id FROM canon_test_print_jobs
       WHERE shop_id = $1 AND status = 'queued'
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id`,
    [shopId]
  );
  if (!result.rows.length) return null;
  return { id: String(result.rows[0].id), kind: "canon_g2010_fixed_test_page" };
}

module.exports = {
  canonTestPrintEnabled, ensureCanonTestPrintTables,
  installCanonTestPrintApis, handleCanonTestHeartbeat
};
