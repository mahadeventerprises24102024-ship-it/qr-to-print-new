"use strict";

const bcrypt = require("bcryptjs");
const { createHash } = require("node:crypto");
const rateLimit = require("express-rate-limit");
const PLANS = Object.freeze(["starter", "pro", "business", "per_page"]);
const PLAN_PRICES = Object.freeze({
  starter: Object.freeze({ label: "Starter", monthlyPaise: 4900, perPagePaise: 0 }),
  pro: Object.freeze({ label: "Pro", monthlyPaise: 9900, perPagePaise: 0 }),
  business: Object.freeze({ label: "Business", monthlyPaise: 19900, perPagePaise: 0 }),
  per_page: Object.freeze({ label: "Pay Per Page", monthlyPaise: 0, perPagePaise: 15 })
});
const DURATION_MONTHS = Object.freeze({ 30: 1, 90: 3, 365: 12 });
function planQuote(planCode, durationDays, pageCount = 0) {
  if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES, planCode) ||
      !Object.prototype.hasOwnProperty.call(DURATION_MONTHS, durationDays) ||
      !Number.isInteger(pageCount) || pageCount < 0 || pageCount > 1000000) {
    throw new Error("Invalid plan, duration, or page count");
  }
  const plan = PLAN_PRICES[planCode];
  return {
    planCode, durationDays,
    periodMonths: DURATION_MONTHS[durationDays],
    upfrontPaise: plan.monthlyPaise * DURATION_MONTHS[durationDays],
    usagePaise: plan.perPagePaise * pageCount,
    pages: pageCount
  };
}
const loginLimiter = rateLimit({
  windowMs:15*60*1000, limit:5, standardHeaders:"draft-7", legacyHeaders:false,
  message:{error:"Too many admin login attempts. Try later."}
});

function adminConfig(env=process.env) {
  const email=(env.PLATFORM_ADMIN_EMAIL||"").trim().toLowerCase();
  const passwordHash=env.PLATFORM_ADMIN_PASSWORD_HASH||"";
  return {
    email, passwordHash,
    configured: email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(passwordHash)
  };
}
function credentialVersion(passwordHash) {
  return createHash("sha256").update(passwordHash).digest("hex");
}
function subscriptionActive(shop,now=new Date()) {
  if (!shop || shop.subscription_status!=="active") return false;
  if(shop.subscription_expires_at == null) return true; // grandfathered shop
  const deadline=new Date(shop.subscription_expires_at);
  return Number.isFinite(deadline.getTime()) && deadline.getTime()>now.getTime();
}
async function ensurePlatformTables(pool) {
  await pool.query("ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(16) NOT NULL DEFAULT 'active'");
  await pool.query("ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_code VARCHAR(16) NOT NULL DEFAULT 'legacy'");
  await pool.query("ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ");
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_subscription_events (",
    "id BIGSERIAL PRIMARY KEY,",
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "action VARCHAR(16) NOT NULL CHECK (action IN ('activate','suspend')),",
    "plan_code VARCHAR(16) NOT NULL,",
    "duration_days SMALLINT,",
    "received_paise INTEGER NOT NULL DEFAULT 0 CHECK (received_paise BETWEEN 0 AND 10000000),",
    "payment_method VARCHAR(8) NOT NULL DEFAULT 'none' CHECK (payment_method IN ('none','cash','upi')),",
    "admin_email VARCHAR(254) NOT NULL,",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    ")"
  ].join(" "));
  await pool.query("CREATE INDEX IF NOT EXISTS subscription_events_shop ON shop_subscription_events(shop_id, created_at DESC)");
  await pool.query([
    "CREATE TABLE IF NOT EXISTS platform_page_usage_events (",
    "id BIGSERIAL PRIMARY KEY,",
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "pages INTEGER NOT NULL CHECK (pages BETWEEN 1 AND 100000),",
    "rate_paise INTEGER NOT NULL CHECK (rate_paise BETWEEN 1 AND 100000),",
    "charge_paise BIGINT NOT NULL CHECK (charge_paise >= 1),",
    "payment_status VARCHAR(8) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),",
    "payment_method VARCHAR(8) NOT NULL DEFAULT 'none' CHECK (payment_method IN ('none','cash','upi')),",
    "recorded_by_email VARCHAR(254) NOT NULL,",
    "paid_at TIMESTAMPTZ,",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    ")"
  ].join(" "));
  await pool.query("CREATE INDEX IF NOT EXISTS platform_page_usage_shop ON platform_page_usage_events(shop_id, created_at DESC, id DESC)");
}
const activeStatusSQL = [
  "SELECT s.subscription_status, s.subscription_expires_at FROM shop_owners o",
  "JOIN shops s ON s.id=o.shop_id WHERE o.id=$1"
].join(" ");
function shopApiGate(pool) {
  return async (req,res,next)=>{
    if(!req.session?.shopOwnerId || ["/logout","/login","/register"].includes(req.path)) return next();
    try {
      const result=await pool.query(activeStatusSQL,[req.session.shopOwnerId]);
      if (!subscriptionActive(result.rows[0])) return res.status(403).json({
        code:"SHOP_SUBSCRIPTION_INACTIVE",
        error:"Shop subscription pending, suspended or expired. Contact platform administrator."
      });
      return next();
    } catch(error) {
      console.error("Shop subscription gate failed:",error);
      return res.status(503).json({error:"Subscription check unavailable"});
    }
  };
}
function shopPageGate(pool) {
  return async (req,res,next)=>{
    if (!req.session?.shopOwnerId) return res.redirect("/shop-login.html");
    try {
      const result=await pool.query(activeStatusSQL,[req.session.shopOwnerId]);
      if(!subscriptionActive(result.rows[0])) return res.redirect("/shop-login.html?inactive=1");
      return next();
    }catch(error){
      console.error("Shop page subscription failed:",error);
      return res.status(503).send("Subscription check unavailable");
    }
  };
}
function publicShopGate(pool) {
  return async(req,res,next)=>{
    if(!/^[a-f0-9]{32}$/.test(req.params.code||"")) return res.status(400).json({error:"Invalid shop code"});
    try {
      const found=await pool.query(
        "SELECT subscription_status, subscription_expires_at FROM shops WHERE public_code=$1",
        [req.params.code]
      );
      if(!found.rows.length)return res.status(404).json({error:"Shop not found"});
      if(!subscriptionActive(found.rows[0]))return res.status(403).json({
        error:"This shop QR is not active. Contact the shop owner."
      });
      next();
    }catch(error){
      console.error("Public shop subscription gate failed:",error);
      return res.status(503).json({error:"Shop unavailable"});
    }
  };
}

function installPlatformAdmin(app,pool,env=process.env) {
  function requireAdmin(req,res,next) {
    const config=adminConfig(env);
    if(!config.configured || req.session?.platformAdminEmail!==config.email ||
       req.session.platformAdminCredentialVersion !== credentialVersion(config.passwordHash)) {
      return res.status(401).json({error:"Platform admin login required"});
    }
    next();
  }
  app.get("/api/platform/plans",requireAdmin,(req,res)=>{
    res.set("Cache-Control","private, no-store");
    return res.json({
      plans: Object.entries(PLAN_PRICES).map(([code,price])=>({
        code, label: price.label, monthlyPaise: price.monthlyPaise,
        perPagePaise: price.perPagePaise
      })),
      durationMonths: DURATION_MONTHS,
      note: "30/90/365-day access terms are priced as 1/3/12 nominal months. No online charge is made. Pay Per Page billing requires manually verified page entries."
    });
  });
  app.get("/api/platform/config",(req,res)=>{
    res.set("Cache-Control","no-store");
    res.json({configured:adminConfig(env).configured});
  });
  app.post("/api/platform/login",loginLimiter,async(req,res)=>{
    const config=adminConfig(env);
    if(!config.configured)return res.status(503).json({
      error:"Super Admin setup incomplete. Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD_HASH on Render."
    });
    const email=typeof req.body?.email==="string"?req.body.email.trim().toLowerCase():"";
    const password=req.body?.password;
    if(typeof password!=="string"||password.length>200||Buffer.byteLength(password)>256||email.length>254){
      return res.status(401).json({error:"Invalid admin login details"});
    }
    try {
      const match=await bcrypt.compare(password,config.passwordHash);
      if(!match||email!==config.email)return res.status(401).json({error:"Invalid admin login details"});
      req.session.regenerate(error=>{
        if(error)return res.status(500).json({error:"Unable to create admin session"});
        req.session.platformAdminEmail=config.email;
        req.session.platformAdminCredentialVersion=credentialVersion(config.passwordHash);
        req.session.save(saveError=>{
          if(saveError)return res.status(500).json({error:"Unable to save admin session"});
          res.set("Cache-Control","no-store");
          res.json({message:"Platform admin logged in"});
        });
      });
    }catch(error){
      console.error("Admin login failed:",error);
      return res.status(503).json({error:"Unable to sign in"});
    }
  });
  app.get("/api/platform/me",requireAdmin,(req,res)=>{
    res.set("Cache-Control","no-store");
    res.json({role:"platform_admin",email:req.session.platformAdminEmail});
  });
  app.post("/api/platform/logout",requireAdmin,(req,res)=>{
    req.session.destroy(error=>{
      if(error)return res.status(500).json({error:"Unable to log out"});
      res.clearCookie("qrprint.sid",{path:"/"});
      res.json({message:"Logged out"});
    });
  });
  app.get("/api/platform/shops",requireAdmin,async(req,res)=>{
    try {
      const shops=await pool.query([
        'SELECT s.id, s.name, s.public_code AS "publicCode", s.created_at AS "createdAt",',
        's.plan_code AS "planCode", s.subscription_status AS "status",',
        's.subscription_expires_at AS "expiresAt",',
        '(SELECT o.name FROM shop_owners o WHERE o.shop_id=s.id ORDER BY o.id LIMIT 1) AS "ownerName",',
        '(SELECT o.email FROM shop_owners o WHERE o.shop_id=s.id ORDER BY o.id LIMIT 1) AS "ownerEmail",',
        '(SELECT COUNT(*)::int FROM test_file_orders t WHERE t.shop_id=s.id) AS "testOrders",',
        '(SELECT COUNT(*)::int FROM shop_print_bills b WHERE b.shop_id=s.id) AS "bills"',
        'FROM shops s ORDER BY s.created_at DESC, s.id DESC LIMIT 200'
      ].join(" "));
      const totals=await pool.query([
        "SELECT COUNT(*)::int AS shops,",
        "COUNT(*) FILTER (WHERE subscription_status='active' AND",
        "(subscription_expires_at IS NULL OR subscription_expires_at > NOW()))::int AS active,",
        "COUNT(*) FILTER (WHERE subscription_status='pending')::int AS pending",
        "FROM shops"
      ].join(" "));
      res.set("Cache-Control","private, no-store");
      res.json({shops:shops.rows,totals:totals.rows[0]});
    }catch(error){
      console.error("Admin shops lookup failed:",error);
      res.status(503).json({error:"Unable to load shops"});
    }
  });
  app.get("/api/platform/subscriptions",requireAdmin,async(req,res)=>{
    try {
      const result=await pool.query([
        'SELECT e.id, e.shop_id AS "shopId", s.name AS "shopName",',
        'e.action,e.plan_code AS "planCode", e.duration_days AS "durationDays",',
        'e.received_paise AS "receivedPaise",e.payment_method AS "paymentMethod",',
        'e.admin_email AS "adminEmail",e.created_at AS "createdAt"',
        "FROM shop_subscription_events e JOIN shops s ON s.id=e.shop_id",
        "ORDER BY e.created_at DESC,e.id DESC LIMIT 100"
      ].join(" "));
      res.set("Cache-Control","private, no-store");
      res.json({events:result.rows});
    }catch(error){
      console.error("Admin subscription history failed:",error);
      res.status(503).json({error:"Unable to load subscription history"});
    }
  });
  app.post("/api/platform/shops/:id/activate",requireAdmin,async(req,res)=>{
    if(!/^[1-9][0-9]{0,14}$/.test(req.params.id||"")){
      return res.status(400).json({error:"Invalid shop ID"});
    }
    const {planCode,durationDays,amountReceivedRupees,paymentMethod,confirmedReceipt}=req.body||{};
    if(!PLANS.includes(planCode)||![30,90,365].includes(durationDays)||
      !Number.isInteger(amountReceivedRupees)||amountReceivedRupees<0||amountReceivedRupees>100000||
      !["none","cash","upi"].includes(paymentMethod)||
      (amountReceivedRupees===0 && paymentMethod!=="none")||
      (amountReceivedRupees>0 && (paymentMethod==="none"||confirmedReceipt!==true))) {
      return res.status(400).json({
        error:"Choose plan, duration and actual received payment. Use ₹0 and None for trial access."
      });
    }
    let client;
    try {
      client=await pool.connect();
      await client.query("BEGIN");
      const update=await client.query([
        "UPDATE shops SET subscription_status='active',plan_code=$2,",
        "subscription_started_at=COALESCE(subscription_started_at,NOW()),",
        "subscription_expires_at=GREATEST(NOW(),COALESCE(subscription_expires_at,NOW())) +",
        "($3::integer * INTERVAL '1 day') WHERE id=$1",
        'RETURNING id,name,plan_code AS "planCode",subscription_status AS "status",',
        'subscription_expires_at AS "expiresAt"'
      ].join(" "),[req.params.id,planCode,durationDays]);
      if(!update.rows.length){
        await client.query("ROLLBACK");
        return res.status(404).json({error:"Shop not found"});
      }
      await client.query([
        "INSERT INTO shop_subscription_events",
        "(shop_id,action,plan_code,duration_days,received_paise,payment_method,admin_email)",
        "VALUES ($1,'activate',$2,$3,$4,$5,$6)"
      ].join(" "),[req.params.id,planCode,durationDays,
        amountReceivedRupees*100,paymentMethod,req.session.platformAdminEmail]);
      await client.query("COMMIT");
      res.set("Cache-Control","no-store");
      res.json({shop:update.rows[0],manualPaymentRecord:true});
    }catch(error){
      if(client){try{await client.query("ROLLBACK");}catch{}}
      console.error("Admin activation failed:",error);
      res.status(503).json({error:"Could not activate shop"});
    }finally{if(client)client.release();}
  });
  // A manual, append-only usage log. Each entry is an independently confirmed
  // print-page count; QR-To-Print does not yet have trusted printer telemetry.
  // The server, not a client-supplied rate, calculates 15 paise/page.
  app.post("/api/platform/shops/:id/page-usage",requireAdmin,async(req,res)=>{
    if(!/^[1-9][0-9]{0,14}$/.test(req.params.id||"")){
      return res.status(400).json({error:"Invalid shop ID"});
    }
    const pages=req.body?.pages;
    if(!Number.isInteger(pages)||pages<1||pages>100000||
       req.body?.confirmedPrintedPages!==true){
      return res.status(400).json({error:"Confirm 1–100000 actual printed pages before recording usage"});
    }
    try {
      const chargePaise=planQuote("per_page",30,pages).usagePaise;
      const result=await pool.query([
        "INSERT INTO platform_page_usage_events",
        "(shop_id,pages,rate_paise,charge_paise,recorded_by_email)",
        "SELECT s.id,$2,$3,$4,$5 FROM shops s",
        "WHERE s.id=$1 AND s.plan_code='per_page' AND s.subscription_status='active'",
        "AND (s.subscription_expires_at IS NULL OR s.subscription_expires_at > NOW())",
        'RETURNING id,shop_id AS "shopId",pages,charge_paise AS "chargePaise",',
        'payment_status AS "paymentStatus"'
      ].join(" "),[req.params.id,pages,PLAN_PRICES.per_page.perPagePaise,
        chargePaise,req.session.platformAdminEmail]);
      if(!result.rows.length) return res.status(409).json({
        error:"Shop not found or Pay Per Page plan is not active"
      });
      res.set("Cache-Control","no-store");
      return res.status(201).json({entry:result.rows[0],manualUsage:true});
    }catch(error){
      console.error("Page usage entry failed:",error);
      return res.status(503).json({error:"Could not record printed pages"});
    }
  });
  app.get("/api/platform/page-usage",requireAdmin,async(req,res)=>{
    try{
      const result=await pool.query([
        'SELECT e.id,e.shop_id AS "shopId",s.name AS "shopName",',
        'e.pages,e.rate_paise AS "ratePaise",e.charge_paise AS "chargePaise",',
        'e.payment_status AS "paymentStatus",e.payment_method AS "paymentMethod",',
        'e.created_at AS "createdAt",e.paid_at AS "paidAt"',
        "FROM platform_page_usage_events e JOIN shops s ON s.id=e.shop_id",
        "ORDER BY e.created_at DESC,e.id DESC LIMIT 100"
      ].join(" "));
      const totals=await pool.query([
        'SELECT COALESCE(SUM(pages),0)::bigint AS "pages",',
        'COALESCE(SUM(charge_paise),0)::bigint AS "totalPaise",',
        'COALESCE(SUM(charge_paise) FILTER (WHERE payment_status=\'unpaid\'),0)::bigint AS "unpaidPaise"',
        "FROM platform_page_usage_events"
      ].join(" "));
      res.set("Cache-Control","private, no-store");
      return res.json({entries:result.rows,totals:totals.rows[0],manuallyRecorded:true});
    }catch(error){
      console.error("Page usage lookup failed:",error);
      return res.status(503).json({error:"Could not load page usage"});
    }
  });
  app.post("/api/platform/page-usage/:id/mark-paid",requireAdmin,async(req,res)=>{
    if(!/^[1-9][0-9]{0,14}$/.test(req.params.id||"") ||
       req.body?.confirmedReceipt!==true ||
       !["cash","upi"].includes(req.body?.paymentMethod)){
      return res.status(400).json({error:"Confirm actual Cash or UPI receipt for a valid page-usage entry"});
    }
    try{
      const result=await pool.query([
        "UPDATE platform_page_usage_events SET payment_status='paid',",
        "payment_method=$2,paid_at=NOW()",
        "WHERE id=$1 AND payment_status='unpaid'",
        'RETURNING id,charge_paise AS "chargePaise",payment_status AS "paymentStatus"'
      ].join(" "),[req.params.id,req.body.paymentMethod]);
      if(!result.rows.length)return res.status(409).json({
        error:"Entry not found or payment already recorded"
      });
      res.set("Cache-Control","no-store");
      return res.json({entry:result.rows[0],manualReceipt:true});
    }catch(error){
      console.error("Usage payment confirmation failed:",error);
      return res.status(503).json({error:"Could not mark usage payment received"});
    }
  });

  app.post("/api/platform/shops/:id/suspend",requireAdmin,async(req,res)=>{
    if(!/^[1-9][0-9]{0,14}$/.test(req.params.id||"")){
      return res.status(400).json({error:"Invalid shop ID"});
    }
    if(req.body?.confirmedSuspension!==true){
      return res.status(400).json({error:"Confirm shop suspension"});
    }
    let client;
    try {
      client=await pool.connect();
      await client.query("BEGIN");
      const update=await client.query([
        "UPDATE shops SET subscription_status='suspended' WHERE id=$1",
        'RETURNING id,name,plan_code AS "planCode",subscription_status AS "status",',
        'subscription_expires_at AS "expiresAt"'
      ].join(" "),[req.params.id]);
      if(!update.rows.length){
        await client.query("ROLLBACK");
        return res.status(404).json({error:"Shop not found"});
      }
      await client.query([
        "INSERT INTO shop_subscription_events(shop_id,action,plan_code,admin_email)",
        "VALUES($1,'suspend',$2,$3)"
      ].join(" "),[req.params.id,update.rows[0].planCode,req.session.platformAdminEmail]);
      await client.query("COMMIT");
      res.set("Cache-Control","no-store");
      res.json({shop:update.rows[0]});
    }catch(error){
      if(client){try{await client.query("ROLLBACK");}catch{}}
      console.error("Admin suspend failed:",error);
      res.status(503).json({error:"Could not suspend shop"});
    }finally{if(client)client.release();}
  });
  return {requireAdmin};
}
module.exports={PLANS,PLAN_PRICES,DURATION_MONTHS,planQuote,adminConfig,credentialVersion,subscriptionActive,ensurePlatformTables,
  shopApiGate,shopPageGate,publicShopGate,installPlatformAdmin};
