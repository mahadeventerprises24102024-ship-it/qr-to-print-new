"use strict";

// This module only pairs and monitors a Windows test agent.
// It does not dispatch, download or print customer documents.
const { randomBytes, createHash } = require("node:crypto");
const rateLimit = require("express-rate-limit");
const { handleCanonTestHeartbeat, canonTestPrintEnabled } = require("./canon-test-print-api");
const { processAgentApprovedHeartbeat, enabled: ownerPrintEnabled } = require("./approved-test-print");

const heartbeatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many agent requests" }
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireShopOwner(req, res, next) {
  if (!req.session || !req.session.shopOwnerId) {
    return res.status(401).json({ error: "Shop login required" });
  }
  next();
}

async function ensureAgentTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_print_agents (
      shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      device_label VARCHAR(80) NOT NULL DEFAULT 'Windows printer PC',
      printer_count SMALLINT NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function installAgentApis(app, pool) {
  app.post("/api/shop/agent/pair", requireShopOwner, async (req, res) => {
    const token = "qrpa_" + randomBytes(32).toString("base64url");
    try {
      const result = await pool.query(
        `INSERT INTO shop_print_agents
           (shop_id, token_hash, printer_count, last_seen_at)
         SELECT shop_id, $2, 0, NULL
         FROM shop_owners WHERE id = $1
         ON CONFLICT (shop_id)
         DO UPDATE SET token_hash = EXCLUDED.token_hash,
                       printer_count = 0,
                       last_seen_at = NULL
         RETURNING shop_id`,
        [req.session.shopOwnerId, sha256(token)]
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: "Shop account unavailable" });
      }
      res.set("Cache-Control", "no-store");
      return res.json({
        token,
        message: "Pairing key created. Keep it private. A new key revokes the previous one.",
        previewOnly: true
      });
    } catch (error) {
      console.error("Agent pairing failed:", error);
      return res.status(503).json({ error: "Unable to create printer agent key" });
    }
  });

  app.get("/api/shop/agent/status", requireShopOwner, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT a.device_label AS "deviceLabel", a.printer_count AS "printerCount",
                a.last_seen_at AS "lastSeenAt",
                (a.last_seen_at IS NOT NULL
                  AND a.last_seen_at > NOW() - INTERVAL '100 seconds') AS "online"
         FROM shop_print_agents a
         JOIN shop_owners o ON o.shop_id = a.shop_id
         WHERE o.id = $1`,
        [req.session.shopOwnerId]
      );
      const agent = result.rows[0] || null;
      res.set("Cache-Control", "no-store");
      return res.json({
        paired: Boolean(agent),
        online: agent ? Boolean(agent.online) : false,
        deviceLabel: agent ? agent.deviceLabel : null,
        printerCount: agent ? agent.printerCount : 0,
        lastSeenAt: agent ? agent.lastSeenAt : null,
        previewOnly: true,
        printingEnabled: false,
        canonTestPrintEnabled: canonTestPrintEnabled()
      });
    } catch (error) {
      console.error("Agent status failed:", error);
      return res.status(503).json({ error: "Unable to read agent status" });
    }
  });

  app.post("/api/shop/agent/revoke", requireShopOwner, async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM shop_print_agents
         WHERE shop_id IN
           (SELECT shop_id FROM shop_owners WHERE id = $1)`,
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      return res.json({ revoked: true });
    } catch (error) {
      console.error("Agent revoke failed:", error);
      return res.status(503).json({ error: "Unable to revoke pairing key" });
    }
  });

  // Node test agent: bearer token instead of a browser cookie.
  // The server's global origin check permits exactly this endpoint
  // without an Origin header; it still denies browser cross-site POSTs.
  app.post("/api/agent/heartbeat", heartbeatLimiter, async (req, res) => {
    if (req.get("origin")) {
      return res.status(403).json({ error: "Browser requests are not allowed" });
    }
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!/^qrpa_[A-Za-z0-9_-]{43}$/.test(token)) {
      return res.status(401).json({ error: "Invalid printer agent key" });
    }

    const { printerCount } = req.body || {};
    if (!Number.isInteger(printerCount) ||
        printerCount < 0 || printerCount > 100) {
      return res.status(400).json({ error: "Invalid printer count" });
    }

    try {
      const result = await pool.query(
        `UPDATE shop_print_agents
         SET printer_count = $2, last_seen_at = NOW()
         WHERE token_hash = $1 RETURNING shop_id`,
        [sha256(token), printerCount]
      );
      if (!result.rows.length) {
        return res.status(401).json({ error: "Printer agent key revoked or invalid" });
      }
      let testPrintJob = null;
      // Old PC agents lack test-print support. Never claim a job for them.
      if ((req.body || {}).supportsCanonTestPrint === true) try {
        testPrintJob = await handleCanonTestHeartbeat(
          pool, result.rows[0].shop_id, (req.body || {}).testPrintResult
        );
      } catch (jobError) {
        if (jobError.message === "Invalid test print acknowledgment") {
          return res.status(400).json({ error: jobError.message });
        }
        console.error("Canon test job processing failed:", jobError);
        // Heartbeat stays online even if the optional test print queue is unavailable.
      }
      let approvedTestJob = null;
      if ((req.body || {}).supportsOwnerApprovedTestPrint === true) {
        try {
          approvedTestJob = await processAgentApprovedHeartbeat(
            pool, result.rows[0].shop_id,
            true, (req.body || {}).ownerPrintResult
          );
        } catch (error) {
          if (error.message === "Invalid approved print acknowledgment") {
            return res.status(400).json({ error: error.message });
          }
          console.error("Approved test print heartbeat processing failed:", error);
          // Do not block agent connection status.
        }
      }
      res.set("Cache-Control", "no-store");
      return res.json({
        connected: true,
        previewOnly: true,
        printingEnabled: false,
        canonTestPrintEnabled: canonTestPrintEnabled(),
        testPrintJob,
        ownerApprovedTestPrintEnabled: ownerPrintEnabled(),
        approvedTestJob
      });
    } catch (error) {
      console.error("Agent heartbeat failed:", error);
      return res.status(503).json({ error: "Unable to update printer agent status" });
    }
  });
}

module.exports = { installAgentApis, ensureAgentTables };
