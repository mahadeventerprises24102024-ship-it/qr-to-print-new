"use strict";

// Shop-owner payment checkout. A billing-only session intentionally cannot
// access the shop dashboard while subscription approval is pending.
// Recipient UPI ID is configured on Render, not hardcoded in source.
const bcrypt=require("bcryptjs");
const QRCode=require("qrcode");
const rateLimit=require("express-rate-limit");
const {planQuote}=require("./platform-admin");

const SELLABLE=Object.freeze(["starter","pro","business"]);
const PERIODS=Object.freeze([30,90,365]);
const paymentLoginLimiter=rateLimit({
  windowMs:15*60*1000,limit:5,standardHeaders:"draft-7",
  legacyHeaders:false,message:{error:"Too many login attempts. Try again later."}
});
const actionLimiter=rateLimit({
  windowMs:15*60*1000,limit:12,standardHeaders:"draft-7",
  legacyHeaders:false,message:{error:"Too many payment requests. Try again later."}
});
function paymentConfig(env=process.env){
  const vpa=typeof env.UPI_PAYMENT_VPA==="string"?env.UPI_PAYMENT_VPA.trim():"";
  const payeeName=typeof env.UPI_PAYMENT_NAME==="string"?env.UPI_PAYMENT_NAME.trim():"";
  const upiEnabled=/^[A-Za-z0-9._-]{2,80}@[A-Za-z0-9._-]{2,50}$/.test(vpa) &&
    payeeName.length>=2 && payeeName.length<=70 && !/[\x00-\x1F\x7F]/.test(payeeName);
  return {upiEnabled,vpa:upiEnabled?vpa:"",payeeName:upiEnabled?payeeName:""};
}
function quote(planCode,durationDays){
  if(!SELLABLE.includes(planCode)||!PERIODS.includes(durationDays))return null;
  const result=planQuote(planCode,durationDays);
  return {planCode,durationDays,amountPaise:result.upfrontPaise};
}
function upiUrl({vpa,payeeName,amountPaise,id}){
  const query=new URLSearchParams({
    pa:vpa,pn:payeeName,am:(amountPaise/100).toFixed(2),
    cu:"INR",tn:"QR-To-Print plan #"+id
  });
  return "upi://pay?"+query.toString();
}
async function ensureSubscriptionPaymentTables(pool){
  await pool.query([
    "CREATE TABLE IF NOT EXISTS platform_payment_requests (",
    "id BIGSERIAL PRIMARY KEY,",
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "owner_id BIGINT NOT NULL REFERENCES shop_owners(id) ON DELETE CASCADE,",
    "kind VARCHAR(12) NOT NULL DEFAULT 'upi_manual' CHECK (kind='upi_manual'),",
    "plan_code VARCHAR(16) NOT NULL CHECK (plan_code IN ('starter','pro','business')),",
    "duration_days SMALLINT NOT NULL CHECK (duration_days IN (30,90,365)),",
    "amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 100 AND 10000000),",
    "upi_vpa VARCHAR(133) NOT NULL,",
    "upi_payee_name VARCHAR(70) NOT NULL,",
    "status VARCHAR(12) NOT NULL DEFAULT 'pending'",
    "CHECK (status IN ('pending','submitted','paid','rejected')),",
    "upi_reference VARCHAR(50) UNIQUE,",
    "reviewed_by VARCHAR(254),",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "paid_at TIMESTAMPTZ",
    ")"
  ].join(" "));
  await pool.query("CREATE INDEX IF NOT EXISTS payment_requests_shop ON platform_payment_requests(shop_id,created_at DESC,id DESC)");
}
function billingOnly(req,res,next){
  if(!req.session?.billingShopId||!req.session?.billingOwnerId){
    return res.status(401).json({error:"Sign in as a shop owner to pay for a plan"});
  }
  next();
}
function validId(id){return /^[1-9][0-9]{0,14}$/.test(String(id||""));}
function formatRequest(r){
  return {
    id:r.id,planCode:r.planCode,durationDays:r.durationDays,
    amountPaise:r.amountPaise,status:r.status,kind:r.kind,
    upiReference:r.upiReference||null,createdAt:r.createdAt
  };
}
async function activateVerifiedPayment(client,payment){
  const changed=await client.query([
    "UPDATE shops SET subscription_status='active',plan_code=$2,",
    "subscription_started_at=COALESCE(subscription_started_at,NOW()),",
    "subscription_expires_at=GREATEST(NOW(),COALESCE(subscription_expires_at,NOW())) +",
    "($3::integer * INTERVAL '1 day') WHERE id=$1",
    "RETURNING id"
  ].join(" "),[payment.shop_id,payment.plan_code,payment.duration_days]);
  if(!changed.rows.length)throw new Error("Paid shop no longer exists");
  await client.query([
    "INSERT INTO shop_subscription_events",
    "(shop_id,action,plan_code,duration_days,received_paise,payment_method,admin_email)",
    "VALUES ($1,'activate',$2,$3,$4,'upi',$5)"
  ].join(" "),[payment.shop_id,payment.plan_code,payment.duration_days,
    payment.amount_paise,payment.reviewed_by]);
}
function installSubscriptionPayments(app,pool,requireAdmin,env=process.env){
  app.get("/api/payments/config",(req,res)=>{
    const c=paymentConfig(env);
    res.set("Cache-Control","no-store");
    res.json({upiEnabled:c.upiEnabled,signInRequired:true});
  });
  // Password check creates a separate, billing-only session. Pending/expired
  // owners cannot turn it into a regular shop-dashboard session.
  app.post("/api/payments/shop-login",paymentLoginLimiter,async(req,res)=>{
    const email=typeof req.body?.email==="string"?req.body.email.trim().toLowerCase():"";
    const pass=req.body?.password;
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||
       typeof pass!=="string"||pass.length>200||Buffer.byteLength(pass)>256){
      return res.status(401).json({error:"Invalid email or password"});
    }
    try{
      const result=await pool.query([
        "SELECT id,shop_id,password_hash FROM shop_owners WHERE email=$1"
      ].join(" "),[email]);
      const owner=result.rows[0];
      if(!owner||!await bcrypt.compare(pass,owner.password_hash)){
        return res.status(401).json({error:"Invalid email or password"});
      }
      req.session.regenerate(error=>{
        if(error)return res.status(503).json({error:"Could not create billing session"});
        req.session.billingShopId=owner.shop_id;
        req.session.billingOwnerId=owner.id;
        req.session.save(saveError=>{
          if(saveError)return res.status(503).json({error:"Could not save billing session"});
          res.set("Cache-Control","no-store");
          return res.json({signedIn:true});
        });
      });
    }catch(error){
      console.error("Billing login failed:",error);
      return res.status(503).json({error:"Unable to sign in"});
    }
  });
  app.post("/api/payments/logout",billingOnly,(req,res)=>{
    req.session.destroy(error=>{
      if(error)return res.status(503).json({error:"Could not sign out"});
      res.clearCookie("qrprint.sid",{path:"/"});
      return res.json({signedOut:true});
    });
  });
  app.get("/api/payments/me",billingOnly,async(req,res)=>{
    try{
      const shop=await pool.query([
        "SELECT s.id,s.name,s.subscription_status,s.plan_code,",
        "s.subscription_expires_at,o.name AS owner_name",
        "FROM shop_owners o JOIN shops s ON s.id=o.shop_id",
        "WHERE o.id=$1 AND o.shop_id=$2"
      ].join(" "),[req.session.billingOwnerId,req.session.billingShopId]);
      if(!shop.rows.length)return res.status(401).json({error:"Billing account not found"});
      const requests=await pool.query([
        'SELECT id,plan_code AS "planCode",duration_days AS "durationDays",',
        'amount_paise AS "amountPaise",status,kind,upi_reference AS "upiReference",',
        'created_at AS "createdAt"',
        "FROM platform_payment_requests WHERE shop_id=$1 AND owner_id=$2",
        "ORDER BY created_at DESC,id DESC LIMIT 15"
      ].join(" "),[req.session.billingShopId,req.session.billingOwnerId]);
      const c=paymentConfig(env);
      res.set("Cache-Control","private, no-store");
      return res.json({
        shop:{id:shop.rows[0].id,name:shop.rows[0].name,
          status:shop.rows[0].subscription_status,planCode:shop.rows[0].plan_code,
          expiresAt:shop.rows[0].subscription_expires_at},
        ownerName:shop.rows[0].owner_name,
        upiEnabled:c.upiEnabled,
        upiPayeeName:c.upiEnabled?c.payeeName:null,
        requests:requests.rows.map(formatRequest)
      });
    }catch(error){
      console.error("Billing overview failed:",error);
      return res.status(503).json({error:"Could not load billing details"});
    }
  });
  async function createManual(req,res){
    const c=paymentConfig(env);
    if(!c.upiEnabled)return res.status(503).json({error:"UPI QR not configured by the platform owner"});
    const q=quote(req.body?.planCode,req.body?.durationDays);
    if(!q)return res.status(400).json({error:"Select Starter, Pro or Business and 30/90/365 days"});
    try{
      const result=await pool.query([
        "INSERT INTO platform_payment_requests",
        "(shop_id,owner_id,kind,plan_code,duration_days,amount_paise,upi_vpa,upi_payee_name,status)",
        "VALUES($1,$2,'upi_manual',$3,$4,$5,$6,$7,'pending')",
        'RETURNING id,amount_paise AS "amountPaise",status'
      ].join(" "),[req.session.billingShopId,req.session.billingOwnerId,
        q.planCode,q.durationDays,q.amountPaise,c.vpa,c.payeeName]);
      res.set("Cache-Control","no-store");
      return res.status(201).json({requestId:result.rows[0].id,
        amountPaise:q.amountPaise,upiPayeeName:c.payeeName,
        upiVpa:c.vpa,qrUrl:"/api/payments/requests/"+result.rows[0].id+"/upi-qr.png",
        manualVerificationRequired:true});
    }catch(error){
      console.error("UPI request creation failed:",error);
      return res.status(503).json({error:"Could not create UPI payment request"});
    }
  }
  app.post("/api/payments/upi-request",actionLimiter,billingOnly,createManual);
  app.get("/api/payments/requests/:id/upi-qr.png",billingOnly,async(req,res)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"Invalid request"});
    const c=paymentConfig(env);
    if(!c.upiEnabled)return res.status(503).json({error:"UPI not configured"});
    try{
      const found=await pool.query([
        "SELECT id,amount_paise,upi_vpa,upi_payee_name FROM platform_payment_requests",
        "WHERE id=$1 AND shop_id=$2 AND owner_id=$3 AND kind='upi_manual'",
        "AND status IN ('pending','submitted')"
      ].join(" "),[req.params.id,req.session.billingShopId,req.session.billingOwnerId]);
      if(!found.rows.length)return res.status(404).json({error:"UPI request not found"});
      const item=found.rows[0];
      const qr=await QRCode.toBuffer(upiUrl({
        vpa:item.upi_vpa,payeeName:item.upi_payee_name,amountPaise:Number(item.amount_paise),id:item.id
      }),{type:"png",width:340,margin:2,errorCorrectionLevel:"M"});
      res.set("Cache-Control","private, no-store");
      return res.type("png").send(qr);
    }catch(error){
      console.error("UPI QR generation failed:",error);
      return res.status(503).json({error:"Could not create QR"});
    }
  });
  app.get("/api/payments/requests/:id/upi-details",billingOnly,async(req,res)=>{
    if(!validId(req.params.id))return res.status(400).json({error:"Invalid request"});
    try{
      const result=await pool.query([
        "SELECT id,amount_paise,upi_vpa,upi_payee_name FROM platform_payment_requests",
        "WHERE id=$1 AND shop_id=$2 AND owner_id=$3 AND kind='upi_manual'",
        "AND status='pending'"
      ].join(" "),[req.params.id,req.session.billingShopId,req.session.billingOwnerId]);
      if(!result.rows.length)return res.status(404).json({error:"Pending UPI request not found for your shop"});
      const item=result.rows[0];
      res.set("Cache-Control","private, no-store");
      return res.json({
        requestId:item.id,amountPaise:Number(item.amount_paise),
        upiVpa:item.upi_vpa,upiPayeeName:item.upi_payee_name,
        qrUrl:"/api/payments/requests/"+item.id+"/upi-qr.png",
        manualVerificationRequired:true
      });
    }catch(error){
      console.error("UPI request detail lookup failed:",error);
      return res.status(503).json({error:"Could not load UPI payment request"});
    }
  });
  app.post("/api/payments/requests/:id/submit-upi",actionLimiter,billingOnly,async(req,res)=>{
    if(!validId(req.params.id)||typeof req.body?.utr!=="string"||
       !/^[0-9A-Za-z]{12,35}$/.test(req.body.utr.trim())){
      return res.status(400).json({error:"Enter the 12–35 character UPI transaction reference / UTR"});
    }
    try{
      const result=await pool.query([
        "UPDATE platform_payment_requests SET status='submitted',",
        "upi_reference=$4,updated_at=NOW()",
        "WHERE id=$1 AND shop_id=$2 AND owner_id=$3",
        "AND kind='upi_manual' AND status='pending'",
        "RETURNING id,status"
      ].join(" "),[req.params.id,req.session.billingShopId,
        req.session.billingOwnerId,req.body.utr.trim()]);
      if(!result.rows.length)return res.status(409).json({
        error:"This UPI request was already submitted, rejected, paid or does not belong to your shop"
      });
      res.set("Cache-Control","no-store");
      return res.json({submitted:true,verified:false,
        message:"UTR submitted. Shop access will activate only after the admin verifies the actual bank/UPI credit."});
    }catch(error){
      if(error.code==="23505")return res.status(409).json({error:"This UTR was already submitted"});
      console.error("UTR submission failed:",error);
      return res.status(503).json({error:"Could not submit UPI reference"});
    }
  });

  app.get("/api/platform/payment-requests",requireAdmin,async(req,res)=>{
    try{
      const result=await pool.query([
        'SELECT p.id,p.kind,p.plan_code AS "planCode",',
        'p.duration_days AS "durationDays",p.amount_paise AS "amountPaise",',
        'p.status,p.upi_reference AS "upiReference",',
        'p.created_at AS "createdAt",s.name AS "shopName",s.id AS "shopId",',
        'o.email AS "ownerEmail"',
        "FROM platform_payment_requests p",
        "JOIN shops s ON s.id=p.shop_id JOIN shop_owners o ON o.id=p.owner_id",
        "ORDER BY p.created_at DESC,p.id DESC LIMIT 100"
      ].join(" "));
      res.set("Cache-Control","private, no-store");
      return res.json({requests:result.rows});
    }catch(error){
      console.error("Admin payment history failed:",error);
      return res.status(503).json({error:"Could not load payment requests"});
    }
  });

  app.post("/api/platform/payment-requests/:id/approve",requireAdmin,async(req,res)=>{
    if(!validId(req.params.id)||req.body?.confirmedReceipt!==true){
      return res.status(400).json({error:"Confirm actual funds credited to your own bank/UPI account"});
    }
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const found=await client.query(
        "SELECT * FROM platform_payment_requests WHERE id=$1 FOR UPDATE",
        [req.params.id]
      );
      const p=found.rows[0];
      if(!p||p.kind!=="upi_manual"||p.status!=="submitted"||!p.upi_reference){
        await client.query("ROLLBACK");
        return res.status(409).json({error:"UPI request not found or not awaiting verification"});
      }
      p.reviewed_by=req.session.platformAdminEmail;
      await activateVerifiedPayment(client,p);
      await client.query([
        "UPDATE platform_payment_requests SET status='paid',",
        "paid_at=NOW(),updated_at=NOW(),reviewed_by=$2 WHERE id=$1"
      ].join(" "),[p.id,p.reviewed_by]);
      await client.query("COMMIT");
      res.set("Cache-Control","no-store");
      return res.json({approved:true,activated:true});
    }catch(error){
      try{await client.query("ROLLBACK");}catch{}
      console.error("UPI approval failed:",error);
      return res.status(503).json({error:"Unable to approve UPI receipt"});
    }finally{client.release();}
  });
  app.post("/api/platform/payment-requests/:id/reject",requireAdmin,async(req,res)=>{
    if(!validId(req.params.id)||req.body?.confirmedRejection!==true){
      return res.status(400).json({error:"Confirm rejection"});
    }
    try{
      const result=await pool.query([
        "UPDATE platform_payment_requests SET status='rejected',",
        "reviewed_by=$2,updated_at=NOW()",
        "WHERE id=$1 AND kind='upi_manual' AND status='submitted'",
        "RETURNING id"
      ].join(" "),[req.params.id,req.session.platformAdminEmail]);
      if(!result.rows.length)return res.status(409).json({error:"Request is not awaiting review"});
      res.set("Cache-Control","no-store");
      return res.json({rejected:true});
    }catch(error){
      console.error("UPI rejection failed:",error);
      return res.status(503).json({error:"Unable to reject request"});
    }
  });
}
module.exports={paymentConfig,quote,upiUrl,
  ensureSubscriptionPaymentTables,installSubscriptionPayments};
