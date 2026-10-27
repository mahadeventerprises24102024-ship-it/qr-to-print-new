
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000
});

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "20kb" }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "qrprint.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please try again later."
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "QR-To-Print backend is running"
  });
});

app.get("/api/db-health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database error:", error.message);
    res.status(503).json({
      status: "error",
      database: "unavailable"
    });
  }
});

function validateCredentials(email, password) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof password === "string" &&
    password.length >= 12 &&
    Buffer.byteLength(password, "utf8") <= 72
  );
}

function createLoginSession(req, res, user) {
  req.session.regenerate((error) => {
    if (error) {
      console.error("Session error:", error);
      return res.status(500).json({
        error: "Unable to create session"
      });
    }

    req.session.userId = user.id;

    req.session.save((saveError) => {
      if (saveError) {
        console.error("Session save error:", saveError);
        return res.status(500).json({
          error: "Unable to save session"
        });
      }

      res.json({
        message: "Login successful",
        user: {
          id: user.id,
          name: user.name,
          email: user.email
        }
      });
    });
  });
}

// Customer registration
app.post("/api/register", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};

  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    name.trim().length > 100 ||
    !validateCredentials(email, password)
  ) {
    return res.status(400).json({
      error: "Enter a valid name, email and password (12+ characters)"
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO customers (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [name.trim(), normalizedEmail, passwordHash]
    );

    return res.status(201).json({
      message: "Registration successful. Please log in.",
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "This email is already registered"
      });
    }

    console.error("Registration error:", error);
    return res.status(500).json({
      error: "Registration failed"
    });
  }
});

// Customer login
app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    email.length > 254 ||
    password.length > 200
  ) {
    return res.status(400).json({
      error: "Invalid login details"
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, password_hash
       FROM customers WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user ||
        !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    createLoginSession(req, res, user);
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Current logged-in customer
app.get("/api/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Not logged in"
    });
  }

  try {
    const result = await pool.query(
      "SELECT id, name, email FROM customers WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "User not found"
      });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ error: "Unable to load profile" });
  }
});

// Customer logout
app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        error: "Logout failed"
      });
    }

    res.clearCookie("qrprint.sid", { path: "/" });
    res.json({ message: "Logged out successfully" });
  });
});

// Existing website
app.use(express.static(path.join(__dirname)));

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  app.listen(PORT, "0.0.0.0", () => {
    console.log("QR-To-Print server running on port " + PORT);
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
