
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000
});

app.use(express.json());

// Serve website files
app.use(express.static(path.join(__dirname)));

// Backend health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "QR-To-Print backend is running"
  });
});

// Database connection check
app.get("/api/db-health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("Database connection failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "unavailable"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QR-To-Print server running on port ${PORT}`);
});
