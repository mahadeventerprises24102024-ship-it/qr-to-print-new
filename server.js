
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { installShopAuth, ensureShopTables } = require("./shop-auth");
const { installDemoOrderApis, ensureDemoOrderTables } = require("./demo-print-orders");
const { installTestFileUploads, ensureTestUploadTables, purgeExpiredTestFiles } = require("./private-test-uploads");
const { checkR2Connectivity } = require("./r2-connectivity");
const { installCustomerPhotoUploads } = require("./customer-photo-uploads");
const { installAgentApis, ensureAgentTables } = require("./printer-agent-api");
const { installCanonTestPrintApis, ensureCanonTestPrintTables } = require("./canon-test-print-api");
const { installShopBilling, ensureShopBillingTables } = require("./shop-billing");
const { installPlatformAdmin, ensurePlatformTables, shopApiGate, shopPageGate, publicShopGate } = require("./platform-admin");
const { installSubscriptionPayments, ensureSubscriptionPaymentTables } = require("./subscription-payments");
const { installPaytmTestPayments, ensurePaytmTestTables } = require("./paytm-print-payments");
const { installUpiPrintPayments, ensureUpiPrintTables } = require("./upi-print-payments");

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

// Reject cross-site state-changing API requests, including customer APIs.
// Browsers send an Origin header with same-origin JSON POST requests.
app.use("/api", (req, res, next) => {
  // The local Windows test agent authenticates with a secret bearer token,
  // not browser cookies. Allow only that exact endpoint without Origin.
  if (req.method === "POST" && req.path === "/agent/heartbeat" &&
      !req.get("origin")) {
    return next();
  }
  // Paytm payment gateway form POST: server callback has no browser Origin.
  // The handler must verify Paytm checksum AND signed status API response.
  if (req.method === "POST" && req.path === "/paytm-print/callback") {
    // Paytm's browser form may send a foreign Origin. Only the signed provider
    // callback + independent signed Transaction Status API can mark Paid.
    return next();
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const expected = req.protocol + "://" + req.get("host");
    if (req.get("origin") !== expected) {
      return res.status(403).json({ error: "Invalid request origin" });
    }
  }
  next();
});

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

// Subscription checks apply to existing sessions and public shop QR routes.
app.use("/api/shop", shopApiGate(pool));
app.use("/api/public/shops/:code", publicShopGate(pool));
const {requireAdmin}=installPlatformAdmin(app, pool);
installSubscriptionPayments(app,pool,requireAdmin);

// Shop endpoints and owners use their own session identity.
installShopAuth(app, pool);
installDemoOrderApis(app, pool);
installTestFileUploads(app, pool);
installCustomerPhotoUploads(app,pool);
installAgentApis(app, pool);
installCanonTestPrintApis(app, pool);
installShopBilling(app, pool);
installPaytmTestPayments(app, pool);
installUpiPrintPayments(app, pool);

// Explicit public assets: never expose backend JavaScript or package.json.
app.get("/access.html", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(__dirname, "access.html"));
});
 // Legacy customer login URL is retired from the public UI.
 // Existing customer data and API handlers are not deleted by this change.
app.get("/login.html", (_req, res) => {
  res.set("Cache-Control", "no-store");
  return res.redirect(302, "/access.html");
});
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
for (const asset of ["style.css", "app.js", "login.html", "shop-login.html", "print.html", "subscription-payment.html", "paytm-print-result.html"]) {
  app.get("/" + asset, (req, res) => {
    res.sendFile(path.join(__dirname, asset));
  });
}

// Serve each dashboard only to its corresponding authenticated role.
app.get("/dashboard.html", (_req, res) => {
  // Retire the former customer dashboard from the public two-login website.
  res.set("Cache-Control", "no-store");
  return res.redirect(302, "/access.html");
});
// Owner-only browser diagnostic: no customer files or backend print commands.
app.get("/shop-printer-check.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'none'; img-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-printer-check.html"));
});
// Owner-only LOCAL print: user-selected files stay on the shop PC.
app.get("/shop-local-print.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'none'; img-src blob:; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-local-print.html"));
});
// Owner-only quick print inbox: uploaded safe TEST orders + local device printing.
// No customer-upload route or anonymous access can serve this page.
app.get("/shop-print-panel.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src blob:; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-print-panel.html"));
});
// Private review page: only authenticated shop owners may open uploaded samples.
app.get("/shop-print-preview.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src blob:; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-print-preview.html"));
});
// Printable basic bill is shop-only; not an official tax invoice.
app.get("/shop-bill.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-bill.html"));
});
// Admin access is separate from all shop and customer roles.
app.get("/admin-login.html", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin-login.html"));
});
app.get("/admin-dashboard.html", (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const config = require("./platform-admin").adminConfig();
  if (!config.configured || req.session?.platformAdminEmail !== config.email ||
      req.session.platformAdminCredentialVersion !==
        require("./platform-admin").credentialVersion(config.passwordHash)) {
    return res.redirect("/admin-login.html");
  }
  return res.sendFile(path.join(__dirname, "admin-dashboard.html"));
});
app.get("/shop-dashboard.html", shopPageGate(pool), (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!req.session || !req.session.shopOwnerId) {
    return res.redirect("/shop-login.html");
  }
  return res.sendFile(path.join(__dirname, "shop-dashboard.html"));
});

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

  await ensureShopTables(pool);
  await ensurePlatformTables(pool);
  await ensureSubscriptionPaymentTables(pool);
  await ensureDemoOrderTables(pool);
  await ensureTestUploadTables(pool);
  await ensureShopBillingTables(pool);
  await ensureAgentTables(pool);
  await ensureCanonTestPrintTables(pool);
  await ensurePaytmTestTables(pool);
  await ensureUpiPrintTables(pool);

  app.listen(PORT, "0.0.0.0", () => {
    console.log("QR-To-Print server running on port " + PORT);
    // Check Cloudflare R2 once with a harmless temporary file; log only
    // redacted capability flags, never bucket names or credentials.
    setTimeout(async()=>{
      try {
        const state=await checkR2Connectivity();
        console.log("R2 sample storage connectivity:",JSON.stringify(state));
      }catch(error){
        console.log("R2 sample storage connectivity:",JSON.stringify({
          configured:false,connectionVerified:false,error:{code:"diagnostic_unavailable"}
        }));
      }
    },1000).unref();
    // Purge expired SAMPLE uploads every 15 minutes while the instance is
    // running; a private R2 bucket 1-day lifecycle is still required.
    let cleanupRunning=false;
    async function cleanupExpiredSampleFiles(){
      if(cleanupRunning)return;
      cleanupRunning=true;
      try{
        const result=await purgeExpiredTestFiles(pool);
        if(result.purged||result.failed){
          console.log("Expired sample files:",JSON.stringify(result));
        }
      }catch(error){
        console.error("Expired SAMPLE file cleanup unavailable:",error);
      }finally{
        cleanupRunning=false;
      }
    }
    setTimeout(cleanupExpiredSampleFiles,5000).unref();
    setInterval(cleanupExpiredSampleFiles,15*60*1000).unref();
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
