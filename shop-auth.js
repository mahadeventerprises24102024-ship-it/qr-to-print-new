"use strict";

const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { randomBytes } = require("node:crypto");

const shopLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." }
});

function sameOriginOnly(req, res, next) {
  // Browser forms send Origin for same-origin JSON POST requests.
  // Fail closed on a missing or cross-origin Origin header.
  const expectedOrigin = req.protocol + "://" + req.get("host");
  if (req.get("origin") !== expectedOrigin) {
    return res.status(403).json({ error: "Request origin not allowed" });
  }
  next();
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" &&
    value.length >= 12 &&
    Buffer.byteLength(value, "utf8") <= 72;
}

function validName(value, limit) {
  return typeof value === "string" &&
    value.trim().length >= 2 &&
    value.trim().length <= limit;
}

function saveShopSession(req, res, account) {
  req.session.regenerate((error) => {
    if (error) {
      console.error("Shop session regeneration failed:", error);
      return res.status(500).json({ error: "Could not start session" });
    }
    // Shop and customer sessions deliberately do not share a role.
    req.session.shopOwnerId = account.owner_id;
    req.session.save((saveError) => {
      if (saveError) {
        console.error("Shop session save failed:", saveError);
        return res.status(500).json({ error: "Could not save session" });
      }
      return res.json({
        message: "Shop login successful",
        shop: {
          id: account.shop_id,
          name: account.shop_name,
          publicCode: account.public_code
        },
        owner: {
          id: account.owner_id,
          name: account.owner_name,
          email: account.email
        }
      });
    });
  });
}

async function ensureShopTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Existing shops are assigned a permanent public QR identifier.
  // gen_random_uuid() is built into PostgreSQL 18 on Render.
  await pool.query("ALTER TABLE shops ADD COLUMN IF NOT EXISTS public_code VARCHAR(32)");
  await pool.query(`
    UPDATE shops
    SET public_code = replace(gen_random_uuid()::text, '-', '')
    WHERE public_code IS NULL
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS shops_public_code_key ON shops(public_code)");
  await pool.query("ALTER TABLE shops ALTER COLUMN public_code SET NOT NULL");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_owners (
      id BIGSERIAL PRIMARY KEY,
      shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function requireShopOwner(req, res, next) {
  if (!req.session || !req.session.shopOwnerId) {
    return res.status(401).json({ error: "Shop login required" });
  }
  next();
}

function installShopAuth(app, pool) {
  // Public lookup reveals only shop name and non-secret QR code.
  // Never expose shop-owner email, password hash or internal shop ID.
  app.get("/api/public/shops/:code", async (req, res) => {
    const code = req.params.code;
    if (!/^[a-f0-9]{32}$/.test(code || "")) {
      return res.status(400).json({ error: "Invalid shop code" });
    }
    try {
      const result = await pool.query(
        "SELECT name, public_code FROM shops WHERE public_code = $1",
        [code]
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: "Shop not found" });
      }
      return res.json({
        shop: { name: result.rows[0].name, publicCode: result.rows[0].public_code }
      });
    } catch (error) {
      console.error("Public shop lookup failed:", error);
      return res.status(503).json({ error: "Shop unavailable" });
    }
  });

  app.post("/api/shop/register", sameOriginOnly, shopLimiter, async (req, res) => {
    const { shopName, ownerName, email, password } = req.body || {};

    if (!validName(shopName, 120) ||
        !validName(ownerName, 100) ||
        !validEmail(email) ||
        !validPassword(password)) {
      return res.status(400).json({
        error: "Enter a valid shop name, owner name, email and a password of 12-72 bytes"
      });
    }

    let client;
    try {
      const emailAddress = email.trim().toLowerCase();
      const hash = await bcrypt.hash(password, 12);
      client = await pool.connect();
      await client.query("BEGIN");
      const shop = await client.query(
        "INSERT INTO shops(name, public_code) VALUES ($1, $2) RETURNING id",
        [shopName.trim(), randomBytes(16).toString("hex")]
      );
      await client.query(
        `INSERT INTO shop_owners(shop_id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [shop.rows[0].id, ownerName.trim(), emailAddress, hash]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        message: "Shop account created. You can now log in."
      });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          console.error("Shop registration rollback failed:", rollbackError);
        }
      }
      if (error.code === "23505") {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      console.error("Shop registration failed:", error);
      return res.status(500).json({ error: "Could not create shop account" });
    } finally {
      if (client) client.release();
    }
  });

  app.post("/api/shop/login", sameOriginOnly, shopLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== "string" ||
        password.length > 200) {
      return res.status(400).json({ error: "Invalid login details" });
    }

    try {
      const result = await pool.query(
        `SELECT o.id AS owner_id, o.name AS owner_name, o.email,
                o.password_hash, s.id AS shop_id, s.name AS shop_name, s.public_code
         FROM shop_owners AS o
         JOIN shops AS s ON s.id = o.shop_id
         WHERE o.email = $1`,
        [email.trim().toLowerCase()]
      );
      const account = result.rows[0];
      // Keep user-facing failure messages the same for absent accounts.
      if (!account || !(await bcrypt.compare(password, account.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      return saveShopSession(req, res, account);
    } catch (error) {
      console.error("Shop login failed:", error);
      return res.status(500).json({ error: "Unable to log in" });
    }
  });

  app.get("/api/shop/me", requireShopOwner, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT o.id AS owner_id, o.name AS owner_name, o.email,
                s.id AS shop_id, s.name AS shop_name, s.public_code
         FROM shop_owners AS o
         JOIN shops AS s ON s.id = o.shop_id
         WHERE o.id = $1`,
        [req.session.shopOwnerId]
      );
      const account = result.rows[0];
      if (!account) {
        return res.status(401).json({ error: "Shop account no longer exists" });
      }
      return res.json({
        shop: { id: account.shop_id, name: account.shop_name,
          publicCode: account.public_code },
        owner: {
          id: account.owner_id,
          name: account.owner_name,
          email: account.email
        }
      });
    } catch (error) {
      console.error("Shop profile failed:", error);
      return res.status(500).json({ error: "Unable to load shop profile" });
    }
  });

  app.post("/api/shop/logout", sameOriginOnly, requireShopOwner, (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        console.error("Shop logout failed:", error);
        return res.status(500).json({ error: "Unable to log out" });
      }
      res.clearCookie("qrprint.sid", { path: "/" });
      return res.json({ message: "Logged out" });
    });
  });
}

module.exports = { installShopAuth, ensureShopTables };
