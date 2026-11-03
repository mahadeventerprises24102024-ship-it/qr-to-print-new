"use strict";

// Six editable shop prices. Historical bills retain the old bw/color labels.
const DEFAULT_RATES_PAISE=Object.freeze({
  bw:300,aadhaar_bw:500,color:1000,
  aadhaar_front:500,aadhaar_back:500,document:300,
  photo_4:1000,photo_2:1000,full_page:1000
});
const SERVICE_TYPES=Object.freeze(["aadhaar_front","aadhaar_back","document","photo_4","photo_2","full_page"]);
const BILL_TYPES=Object.freeze([...SERVICE_TYPES,"bw","aadhaar_bw","color"]);
const FIELD_TO_CATEGORY=Object.freeze({
  aadhaarFront:"aadhaar_front",aadhaarBack:"aadhaar_back",
  document:"document",photo4:"photo_4",photo2:"photo_2",fullPage:"full_page"
});
function ratesFromRow(row){
  const r=row||{};
  const value=(column,legacy)=>Number(r[column]!=null?r[column]:
    r[legacy]!=null?r[legacy]:DEFAULT_RATES_PAISE[column.replace("_paise","")])/100;
  return {
    aadhaarFront:value("aadhaar_front_paise","aadhaar_bw_paise"),
    aadhaarBack:value("aadhaar_back_paise","aadhaar_bw_paise"),
    document:value("document_paise","bw_paise"),
    photo4:value("photo_4_paise","color_paise"),
    photo2:value("photo_2_paise","color_paise"),
    fullPage:value("full_page_paise","color_paise")
  };
}

function validRupee(value) {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 1 && value <= 1000;
}

function calculateBill(category, pagesPerCopy, copies, ratePaise) {
  if (!BILL_TYPES.includes(category) ||
      !Number.isInteger(pagesPerCopy) || pagesPerCopy < 1 || pagesPerCopy > 200 ||
      !Number.isInteger(copies) || copies < 1 || copies > 10 ||
      !Number.isInteger(ratePaise) || ratePaise < 100 || ratePaise > 100000) {
    throw new Error("Invalid bill settings");
  }
  const oneSheet=["aadhaar_front","aadhaar_back","photo_2","photo_4","full_page","aadhaar_bw"].includes(category);
  if(oneSheet&&pagesPerCopy!==1)throw new Error("Single-sheet service requires one page per copy");
  const quantity=oneSheet?copies:pagesPerCopy*copies;
  return { quantity, totalPaise: quantity * ratePaise };
}

async function ensureShopBillingTables(pool) {
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_print_rates (",
    "shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,",
    "bw_paise INTEGER NOT NULL DEFAULT 300 CHECK (bw_paise BETWEEN 100 AND 100000),",
    "aadhaar_bw_paise INTEGER NOT NULL DEFAULT 500 CHECK (aadhaar_bw_paise BETWEEN 100 AND 100000),",
    "color_paise INTEGER NOT NULL DEFAULT 1000 CHECK (color_paise BETWEEN 100 AND 100000),",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    ")"
  ].join(" "));
  for(const column of [
    "aadhaar_front_paise","aadhaar_back_paise","document_paise",
    "photo_4_paise","photo_2_paise","full_page_paise"
  ])await pool.query("ALTER TABLE shop_print_rates ADD COLUMN IF NOT EXISTS "+
    column+" INTEGER CHECK ("+column+" BETWEEN 100 AND 100000)");
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_print_bills (",
    "id BIGSERIAL PRIMARY KEY,",
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "order_id BIGINT UNIQUE REFERENCES test_file_orders(id) ON DELETE SET NULL,",
    "order_reference_id BIGINT NOT NULL,",
    "shop_name VARCHAR(120) NOT NULL,",
    "category VARCHAR(16) NOT NULL CHECK (category IN ('bw','aadhaar_bw','color','aadhaar_front','aadhaar_back','document','photo_4','photo_2','full_page')),",
    "pages_per_copy SMALLINT NOT NULL CHECK (pages_per_copy BETWEEN 1 AND 200),",
    "copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 10),",
    "quantity SMALLINT NOT NULL CHECK (quantity BETWEEN 1 AND 2000),",
    "rate_paise INTEGER NOT NULL CHECK (rate_paise BETWEEN 100 AND 100000),",
    "total_paise BIGINT NOT NULL CHECK (total_paise BETWEEN 100 AND 200000000),",
    "payment_status VARCHAR(16) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),",
    "payment_method VARCHAR(8) CHECK (payment_method IN ('cash','upi')),",
    "paid_at TIMESTAMPTZ,",
    "issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    ")"
  ].join(" "));
  await pool.query("ALTER TABLE shop_print_bills DROP CONSTRAINT IF EXISTS shop_print_bills_category_check");
  await pool.query("ALTER TABLE shop_print_bills ADD CONSTRAINT shop_print_bills_category_check "+
    "CHECK (category IN ('bw','aadhaar_bw','color','aadhaar_front','aadhaar_back','document','photo_4','photo_2','full_page'))");
  await pool.query("CREATE INDEX IF NOT EXISTS shop_print_bills_shop_recent ON shop_print_bills(shop_id, issued_at DESC, id DESC)");
}

function installShopBilling(app, pool) {
  function ownerOnly(req, res, next) {
    if (!req.session || !req.session.shopOwnerId) {
      return res.status(401).json({ error: "Shop login required" });
    }
    next();
  }

  // Only public shop name and three prices are visible to QR visitors.
  app.get("/api/public/shops/:code/pricing", async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.code || "")) {
      return res.status(400).json({ error: "Invalid shop QR code" });
    }
    try {
      const result = await pool.query([
        "SELECT s.name, r.bw_paise, r.aadhaar_bw_paise, r.color_paise",
        "FROM shops s LEFT JOIN shop_print_rates r ON r.shop_id = s.id",
        "WHERE s.public_code = $1"
      ].join(" "), [req.params.code]);
      if (!result.rows.length) return res.status(404).json({ error: "Shop not found" });
      res.set("Cache-Control", "no-store");
      return res.json({
        shopName: result.rows[0].name,
        ratesRupees: ratesFromRow(result.rows[0]),
        manualQuote: true,
        testOnly: true
      });
    } catch (error) {
      console.error("Public shop rates failed:", error);
      return res.status(503).json({ error: "Could not load shop prices" });
    }
  });

  app.get("/api/shop/pricing", ownerOnly, async (req, res) => {
    try {
      const result = await pool.query([
        "SELECT s.name, r.bw_paise, r.aadhaar_bw_paise, r.color_paise",
        "FROM shop_owners o JOIN shops s ON s.id = o.shop_id",
        "LEFT JOIN shop_print_rates r ON r.shop_id = s.id WHERE o.id = $1"
      ].join(" "), [req.session.shopOwnerId]);
      if (!result.rows.length) return res.status(404).json({ error: "Shop not found" });
      res.set("Cache-Control", "no-store");
      return res.json({
        shopName: result.rows[0].name,
        ratesRupees: ratesFromRow(result.rows[0]),
        testOnly: true
      });
    } catch (error) {
      console.error("Shop rates failed:", error);
      return res.status(503).json({ error: "Could not load shop prices" });
    }
  });

  app.put("/api/shop/pricing", ownerOnly, async (req, res) => {
    const rates = req.body && req.body.ratesRupees;
    if (!rates || !validRupee(rates.bw) ||
        !validRupee(rates.aadhaarBw) || !validRupee(rates.color)) {
      return res.status(400).json({ error: "Enter whole-rupee rates from ₹1 to ₹1000" });
    }
    try {
      const result = await pool.query([
        "INSERT INTO shop_print_rates (shop_id, bw_paise, aadhaar_bw_paise, color_paise)",
        "SELECT o.shop_id, $2, $3, $4 FROM shop_owners o WHERE o.id = $1",
        "ON CONFLICT (shop_id) DO UPDATE SET",
        "bw_paise = EXCLUDED.bw_paise, aadhaar_bw_paise = EXCLUDED.aadhaar_bw_paise,",
        "color_paise = EXCLUDED.color_paise, updated_at = NOW()",
        "RETURNING bw_paise, aadhaar_bw_paise, color_paise"
      ].join(" "), [
        req.session.shopOwnerId, rates.bw * 100, rates.aadhaarBw * 100, rates.color * 100
      ]);
      if (!result.rows.length) return res.status(404).json({ error: "Shop not found" });
      res.set("Cache-Control", "no-store");
      return res.json({ saved: true, ratesRupees: ratesFromRow(result.rows[0]) });
    } catch (error) {
      console.error("Saving shop rates failed:", error);
      return res.status(503).json({ error: "Could not save shop prices" });
    }
  });

  // No client-supplied price or copy count is trusted. Owner confirms actual
  // page count after reviewing the PDF before creating the immutable bill.
  app.post("/api/shop/test-file-orders/:id/bill", ownerOnly, async (req, res) => {
    if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
      return res.status(400).json({ error: "Invalid order ID" });
    }
    const category = req.body && req.body.category;
    const pages = req.body && req.body.pagesPerCopy;
    if (!BILL_TYPES.includes(category) ||
        !Number.isInteger(pages) || pages < 1 || pages > 200 ||
        (category === "aadhaar_bw" && pages !== 1)) {
      return res.status(400).json({ error: "Choose print type and actual pages (1–200). Aadhaar B&W counts as one card per copy." });
    }
    try {
      const found = await pool.query([
        "SELECT o.id, o.copies, o.print_mode, o.status, s.name AS shop_name,",
        "r.bw_paise, r.aadhaar_bw_paise, r.color_paise",
        "FROM test_file_orders o",
        "JOIN shop_owners owner ON owner.shop_id = o.shop_id",
        "JOIN shops s ON s.id = o.shop_id",
        "LEFT JOIN shop_print_rates r ON r.shop_id = s.id",
        "WHERE owner.id = $1 AND o.id = $2"
      ].join(" "), [req.session.shopOwnerId, req.params.id]);
      if (!found.rows.length) {
        return res.status(404).json({ error: "Order not found for this shop" });
      }
      const order = found.rows[0];
      if (order.status !== "printed") {
        return res.status(409).json({ error: "First print and confirm paper output, then issue the bill" });
      }
      if ((order.print_mode === "color" && category !== "color") ||
          (order.print_mode === "bw" && category === "color")) {
        return res.status(400).json({ error: "Bill type must match the order colour mode" });
      }
      const key = category + "_paise";
      const ratePaise = Number(order[key] == null ? DEFAULT_RATES_PAISE[category] : order[key]);
      const copies = Number(order.copies);
      const calculated = calculateBill(category, pages, copies, ratePaise);
      const saved = await pool.query([
        "INSERT INTO shop_print_bills",
        "(shop_id, order_id, order_reference_id, shop_name, category, pages_per_copy, copies, quantity, rate_paise, total_paise)",
        "SELECT o.shop_id, o.id, o.id, $3, $4, $5, $6, $7, $8, $9",
        "FROM test_file_orders o JOIN shop_owners owner ON owner.shop_id = o.shop_id",
        "WHERE owner.id = $1 AND o.id = $2 AND o.status = 'printed'",
        "ON CONFLICT (order_id) DO NOTHING",
        "RETURNING id"
      ].join(" "), [
        req.session.shopOwnerId, req.params.id, order.shop_name, category,
        pages, copies, calculated.quantity, ratePaise, calculated.totalPaise
      ]);
      if (!saved.rows.length) {
        return res.status(409).json({ error: "Bill already exists or order is not printed" });
      }
      res.set("Cache-Control", "no-store");
      return res.status(201).json({ billId: saved.rows[0].id, amountPaise: calculated.totalPaise, paymentStatus: "unpaid" });
    } catch (error) {
      console.error("Creating shop bill failed:", error);
      return res.status(503).json({ error: "Could not create bill" });
    }
  });

  const selectBill = [
    "SELECT b.id, b.order_reference_id AS \"orderId\", b.shop_name AS \"shopName\",",
    "b.category, b.pages_per_copy AS \"pagesPerCopy\", b.copies, b.quantity,",
    "b.rate_paise AS \"ratePaise\", b.total_paise AS \"totalPaise\",",
    "b.payment_status AS \"paymentStatus\", b.payment_method AS \"paymentMethod\",",
    "b.issued_at AS \"issuedAt\", b.paid_at AS \"paidAt\"",
    "FROM shop_print_bills b JOIN shop_owners o ON o.shop_id = b.shop_id",
    "WHERE o.id = $1"
  ].join(" ");

  app.get("/api/shop/bills", ownerOnly, async (req, res) => {
    try {
      const result = await pool.query(
        selectBill + " ORDER BY b.issued_at DESC, b.id DESC LIMIT 50",
        [req.session.shopOwnerId]
      );
      res.set("Cache-Control", "no-store");
      return res.json({ bills: result.rows, testOnly: true });
    } catch (error) {
      console.error("Listing bills failed:", error);
      return res.status(503).json({ error: "Could not load bills" });
    }
  });

  app.get("/api/shop/bills/:id", ownerOnly, async (req, res) => {
    if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
      return res.status(400).json({ error: "Invalid bill ID" });
    }
    try {
      const result = await pool.query(
        selectBill + " AND b.id = $2",
        [req.session.shopOwnerId, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: "Bill not found" });
      res.set("Cache-Control", "private, no-store");
      return res.json({ bill: result.rows[0], testOnly: true });
    } catch (error) {
      console.error("Loading bill failed:", error);
      return res.status(503).json({ error: "Could not load bill" });
    }
  });

  // Manual cash / external UPI confirmation; never claim online payment.
  app.post("/api/shop/bills/:id/mark-paid", ownerOnly, async (req, res) => {
    if (!/^[1-9][0-9]{0,14}$/.test(req.params.id || "")) {
      return res.status(400).json({ error: "Invalid bill ID" });
    }
    if (!req.body || req.body.confirmedReceipt !== true ||
        !["cash", "upi"].includes(req.body.paymentMethod)) {
      return res.status(400).json({ error: "Confirm received cash or external UPI payment" });
    }
    try {
      const result = await pool.query([
        "UPDATE shop_print_bills b SET payment_status = 'paid',",
        "payment_method = $3, paid_at = NOW()",
        "FROM shop_owners o WHERE o.shop_id = b.shop_id",
        "AND o.id = $1 AND b.id = $2 AND b.payment_status = 'unpaid'",
        "RETURNING b.id, b.payment_status AS \"paymentStatus\""
      ].join(" "), [req.session.shopOwnerId, req.params.id, req.body.paymentMethod]);
      if (!result.rows.length) {
        return res.status(409).json({ error: "Bill not found for your shop, or already marked paid" });
      }
      res.set("Cache-Control", "no-store");
      return res.json({ bill: result.rows[0], manualPayment: true });
    } catch (error) {
      console.error("Manual payment confirmation failed:", error);
      return res.status(503).json({ error: "Could not update payment status" });
    }
  });
}

module.exports = { DEFAULT_RATES_PAISE,SERVICE_TYPES,FIELD_TO_CATEGORY,ratesFromRow,validRupee,calculateBill,
  ensureShopBillingTables, installShopBilling };
