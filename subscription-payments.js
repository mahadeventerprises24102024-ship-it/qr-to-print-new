"use strict";

// Shop-owner payment checkout. A billing-only session intentionally cannot
// access the shop dashboard while subscription approval is pending.
// No credentials, UPI VPA or Paytm key secrets are stored in source code.
const bcrypt=require("bcryptjs");
const QRCode=require("qrcode");
const express=require("express");
const PaytmChecksum=require("paytmchecksum");
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
  const vpa=(env.UPI_PAYMENT_VPA||"").trim();
  const payeeName=(env.UPI_PAYMENT_NAME||"").trim();
  const upiEnabled=/^[a-zA-Z0-9._-]{2,80}@[a-zA-Z0-9._-]{2,50}$/.test(vpa)
    && payeeName.length>=2 && payeeName.length<=70 && !/[<>&]/.test(payeeName);
  const mid=(env.PAYTM_MID||"").trim();
  const merchantKey=env.PAYTM_MERCHANT_KEY||"";
  const mode=env.PAYTM_ENV==="live"?"live":"test";
  const website=(env.PAYTM_WEBSITE_NAME|| (mode==="live"?"DEFAULT":"WEBSTAGING")).trim();
  const validCred=/^[A-Za-z0-9]{8,36}$/.test(mid)&&merchantKey.length>=16&&merchantKey.length<=200&&/^[A-Za-z0-9_-]{2,40}$/.test(website);
  let origin;
  try{
    const u=new URL(env.PUBLIC_BASE_URL||"https://qr-to-print-new.onrender.com");
    if(u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash&&(u.pathname==="/"||!u.pathname))origin=u.origin;
  }catch{}
  return {upiEnabled,vpa:upiEnabled?vpa:"",payeeName:upiEnabled?payeeName:"",
    gatewayEnabled:validCred&&!!origin,mid:validCred?mid:"",
    merchantKey:validCred?merchantKey:"",website,mode,
    host:mode==="live"?"https://secure.paytmpayments.com":"https://securestage.paytmpayments.com",
    origin};

}
function quote(planCode,durationDays){
  if(!SELLABLE.includes(planCode)||!PERIODS.includes(durationDays))return null;
  const result=planQuote(planCode,durationDays);
  return {planCode,durationDays,amountPaise:result.upfrontPaise};
}
function secureMatch(value,expectedHex,secret){
  if(typeof value!=="string"||!/^[a-f0-9]{64}$/i.test(value)||
    typeof secret!=="string"||!secret)return false;
  const got=Buffer.from(value,"hex");
  const expected=createHmac("sha256",secret).update(expectedHex).digest();
  return got.length===expected.length && timingSafeEqual(got,expected);
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
    "kind VARCHAR(12) NOT NULL CHECK (kind IN ('upi_manual','paytm')),",
    "plan_code VARCHAR(16) NOT NULL CHECK (plan_code IN ('starter','pro','business')),",
    "duration_days SMALLINT NOT NULL CHECK (duration_days IN (30,90,365)),",
    "amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 100 AND 10000000),",
    "status VARCHAR(12) NOT NULL DEFAULT 'pending'",
    "CHECK (status IN ('draft','pending','submitted','paid','test_paid','rejected')),",
    "upi_reference VARCHAR(50) UNIQUE,",
    "paytm_order_id VARCHAR(70) UNIQUE,",
    "paytm_transaction_id VARCHAR(70) UNIQUE,",
    "gateway_mode VARCHAR(8) CHECK (gateway_mode IN ('live','test')),",
    "reviewed_by VARCHAR(254),",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "paid_at TIMESTAMPTZ",
    ")"
  ].join(" "));
  await pool.query("CREATE INDEX IF NOT EXISTS payment_requests_shop ON platform_payment_requests(shop_id,created_at DESC,id DESC)");
  // Allow truthful 'gateway' audit labeling for automatic Paytm receipts.
  // Old deployments created this named constraint as part of CREATE TABLE.
  await pool.query([
    "DO $$ BEGIN",
    "IF EXISTS (SELECT 1 FROM pg_constraint",
    "WHERE conrelid='shop_subscription_events'::regclass",
    "AND conname='shop_subscription_events_payment_method_check'",
    "AND pg_get_constraintdef(oid) NOT LIKE '%gateway%') THEN",
    "ALTER TABLE shop_subscription_events",
    "DROP CONSTRAINT shop_subscription_events_payment_method_check;",
    "END IF;",
    "IF NOT EXISTS (SELECT 1 FROM pg_constraint",
    "WHERE conrelid='shop_subscription_events'::regclass",
    "AND conname='shop_subscription_events_payment_method_check') THEN",
    "ALTER TABLE shop_subscription_events ADD CONSTRAINT",
    "shop_subscription_events_payment_method_check",
    "CHECK (payment_method IN ('none','cash','upi','gateway'));",
    "END IF;",
    "END $$;"
  ].join(" "));
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
    upiReference:r.upiReference||null,createdAt:r.createdAt,
    gatewayMode:r.gatewayMode||null
  };
}
async function activateVerifiedPayment(client,payment,method){
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
    "VALUES ($1,'activate',$2,$3,$4,$5,$6)"
  ].join(" "),[payment.shop_id,payment.plan_code,payment.duration_days,
    payment.amount_paise,method,
    method==="gateway"?"verified-paytm@system.internal":payment.reviewed_by]);
}
// Calling this twice with one Paytm order is safe: a DB row-lock
// guarantees at-most-once subscription extension.
async function settleCapturedGateway(pool,verified){
  if(!/^[a-zA-Z0-9_-]{6,70}$/.test(verified.orderId||"")||
     !/^[a-zA-Z0-9_-]{6,70}$/.test(verified.paymentId||"")||
     verified.currency!=="INR"||verified.status!=="captured"||
     !Number.isInteger(verified.amountPaise)||verified.amountPaise<=0){
    throw new Error("Invalid captured payment details");
  }
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const found=await client.query(
      "SELECT * FROM platform_payment_requests WHERE paytm_order_id=$1 FOR UPDATE",
      [verified.orderId]
    );
    const p=found.rows[0];
    if(!p||p.kind!=="paytm"||Number(p.amount_paise)!==verified.amountPaise){
      await client.query("ROLLBACK");
      return {status:"unmatched"};
    }
    if(p.status==="paid"||p.status==="test_paid"){
      await client.query("COMMIT");
      return {status:p.status};
    }
    if(p.status!=="pending"||!["test","live"].includes(p.gateway_mode)){
      await client.query("ROLLBACK");
      return {status:"not_pending"};
    }
    const status=p.gateway_mode==="live"?"paid":"test_paid";
    await client.query(
      "UPDATE platform_payment_requests SET status=$2,paytm_transaction_id=$3,paid_at=NOW(),updated_at=NOW() WHERE id=$1",
      [p.id,status,verified.paymentId]
    );
    if(status==="paid")await activateVerifiedPayment(client,p,"gateway");
    await client.query("COMMIT");
    return {status,requestId:p.id};
  }catch(error){
    try{await client.query("ROLLBACK");}catch{}
    throw error;
  }finally{client.release();}
}
async function paytmFetch(config,path,options={},fetchImpl=fetch){
  const credentials=Buffer.from(config.keyId+":"+config.keySecret,"utf8").toString("base64");
  const res=await fetchImpl("https://api.paytm.com/v1/"+path,{
    ...options,
    headers:{"Authorization":"Basic "+credentials,
      "Content-Type":"application/json"},
    signal:AbortSignal.timeout(10000)
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error("Gateway API returned "+res.status);
  return data;
}
// Webhook route MUST be registered before express.json and the normal browser
// Origin guard; Paytm webhooks do not carry same-origin browser headers.
function installPaymentWebhook(app,pool,env=process.env,fetchImpl=fetch){
  app.post("/api/payments/paytm/webhook",
    express.raw({type:"application/json",limit:"128kb"}),
    async(req,res)=>{
      const config=paymentConfig(env);
      if(!config.gatewayEnabled)return res.status(503).json({error:"Gateway not configured"});
      if(!Buffer.isBuffer(req.body))return res.status(415).end();
      const signature=req.get("x-paytm-signature");
      if(!secureMatch(signature,req.body,config.webhookSecret)){
        return res.status(400).end();
      }
      let event;
      try{event=JSON.parse(req.body.toString("utf8"));}
      catch{return res.status(400).end();}
      if(event?.event!=="payment.captured")return res.status(200).json({received:true});
      const entity=event?.payload?.payment?.entity;
      if(entity?.status!=="captured"||!entity?.id||!entity?.order_id){
        return res.status(400).end();
      }
      try{
        // Back-to-back signed webhook + backend payment lookup for defense in depth.
        const payment=await paytmFetch(config,"payments/"+encodeURIComponent(entity.id),{},fetchImpl);
        if(payment.id!==entity.id||payment.order_id!==entity.order_id||
           payment.status!=="captured"||payment.currency!=="INR"||
           payment.amount!==entity.amount)return res.status(409).end();
        const result=await settleCapturedGateway(pool,{
          orderId:payment.order_id,paymentId:payment.id,status:payment.status,
          currency:payment.currency,amountPaise:payment.amount
        });
        // Unknown transactions are not activated; 200 avoids endless retries
        // for a payment outside this app's order ledger.
        return res.status(200).json({received:true,status:result.status});
      }catch(error){
        console.error("Gateway webhook processing failed:",error);
        return res.status(503).json({error:"Webhook retry required"});
      }
    }
  );
}
function installSubscriptionPayments(app,pool,requireAdmin,env=process.env,fetchImpl=fetch){
  app.get("/api/payments/config",(req,res)=>{
    const c=paymentConfig(env);
    res.set("Cache-Control","no-store");
    res.json({upiEnabled:c.upiEnabled,gatewayEnabled:c.gatewayEnabled,
      gatewayMode:c.gatewayEnabled?c.mode:null,
      signInRequired:true});
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
        'created_at AS "createdAt",gateway_mode AS "gatewayMode"',
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
        upiEnabled:c.upiEnabled,gatewayEnabled:c.gatewayEnabled,
        gatewayMode:c.gatewayEnabled?c.mode:null,
        upiPayeeName:c.upiEnabled?c.payeeName:null,
        gatewayKeyId:c.gatewayEnabled?c.keyId:null,
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
        "(shop_id,owner_id,kind,plan_code,duration_days,amount_paise,status)",
        "VALUES($1,$2,'upi_manual',$3,$4,$5,'pending')",
        'RETURNING id,amount_paise AS "amountPaise",status'
      ].join(" "),[req.session.billingShopId,req.session.billingOwnerId,
        q.planCode,q.durationDays,q.amountPaise]);
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
        "SELECT id,amount_paise FROM platform_payment_requests",
        "WHERE id=$1 AND shop_id=$2 AND owner_id=$3 AND kind='upi_manual'",
        "AND status IN ('pending','submitted')"
      ].join(" "),[req.params.id,req.session.billingShopId,req.session.billingOwnerId]);
      if(!found.rows.length)return res.status(404).json({error:"UPI request not found"});
      const item=found.rows[0];
      const qr=await QRCode.toBuffer(upiUrl({
        vpa:c.vpa,payeeName:c.payeeName,amountPaise:Number(item.amount_paise),id:item.id
      }),{type:"png",width:340,margin:2,errorCorrectionLevel:"M"});
      res.set("Cache-Control","private, no-store");
      return res.type("png").send(qr);
    }catch(error){
      console.error("UPI QR generation failed:",error);
      return res.status(503).json({error:"Could not create QR"});
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
  app.post("/api/payments/paytm-order",actionLimiter,billingOnly,async(req,res)=>{
    const c=paymentConfig(env);
    if(!c.gatewayEnabled)return res.status(503).json({error:"Paytm keys and webhook secret are not configured"});
    const q=quote(req.body?.planCode,req.body?.durationDays);
    if(!q)return res.status(400).json({error:"Select Starter, Pro or Business and 30/90/365 days"});
    let draft;
    try{
      const created=await pool.query([
        "INSERT INTO platform_payment_requests",
        "(shop_id,owner_id,kind,plan_code,duration_days,amount_paise,status,gateway_mode)",
        "VALUES($1,$2,'paytm',$3,$4,$5,'draft',$6) RETURNING id"
      ].join(" "),[req.session.billingShopId,req.session.billingOwnerId,
        q.planCode,q.durationDays,q.amountPaise,c.mode]);
      draft=created.rows[0].id;
      const order=await paytmFetch(c,"orders",{
        method:"POST",body:JSON.stringify({
          amount:q.amountPaise,currency:"INR",receipt:"qrp_"+draft,
          notes:{shop_payment_request:String(draft)}
        })
      },fetchImpl);
      if(!/^order_[A-Za-z0-9]+$/.test(order.id||"")||
         order.amount!==q.amountPaise||order.currency!=="INR"){
        throw new Error("Gateway order mismatch");
      }
      await pool.query([
        "UPDATE platform_payment_requests SET status='pending',",
        "paytm_order_id=$2,updated_at=NOW() WHERE id=$1 AND status='draft'"
      ].join(" "),[draft,order.id]);
      res.set("Cache-Control","no-store");
      return res.status(201).json({
        requestId:draft,orderId:order.id,keyId:c.keyId,amountPaise:q.amountPaise,
        currency:"INR",gatewayMode:c.mode,
        testOnly:c.mode==="test"
      });
    }catch(error){
      console.error("Paytm order failed:",error);
      return res.status(503).json({
        error:"Could not create a gateway checkout. No payment is confirmed; please retry later."
      });
    }
  });
  app.post("/api/payments/paytm-verify",actionLimiter,billingOnly,async(req,res)=>{
    const c=paymentConfig(env);
    if(!c.gatewayEnabled)return res.status(503).json({error:"Paytm not configured"});
    const id=req.body?.paytm_order_id,paid=req.body?.paytm_transaction_id,
      signature=req.body?.paytm_signature;
    if(!/^order_[A-Za-z0-9]+$/.test(id||"")||
       !/^pay_[A-Za-z0-9]+$/.test(paid||"")||
       !secureMatch(signature,id+"|"+paid,c.keySecret)){
      return res.status(400).json({error:"Invalid payment signature"});
    }
    try{
      const own=await pool.query([
        "SELECT id FROM platform_payment_requests",
        "WHERE paytm_order_id=$1 AND shop_id=$2 AND owner_id=$3"
      ].join(" "),[id,req.session.billingShopId,req.session.billingOwnerId]);
      if(!own.rows.length)return res.status(404).json({error:"Payment order not found for this shop"});
      const payment=await paytmFetch(c,"payments/"+encodeURIComponent(paid),{},fetchImpl);
      if(payment.id!==paid||payment.order_id!==id||
         payment.status!=="captured"||payment.currency!=="INR"){
        return res.status(409).json({error:"Payment is not captured yet. Check again later."});
      }
      const result=await settleCapturedGateway(pool,{
        orderId:id,paymentId:paid,status:payment.status,
        currency:payment.currency,amountPaise:payment.amount
      });
      if(!["paid","test_paid"].includes(result.status))return res.status(409).json({
        error:"Payment could not be matched to the expected order amount"
      });
      res.set("Cache-Control","no-store");
      return res.json({status:result.status,
        activated:result.status==="paid",
        message:result.status==="paid"?"Captured payment verified. Shop subscription activated.":"Paytm TEST payment verified; shop subscription NOT activated."});
    }catch(error){
      console.error("Gateway payment verification failed:",error);
      return res.status(503).json({error:"Could not verify captured payment. Please retry later."});
    }
  });
  app.get("/api/platform/payment-requests",requireAdmin,async(req,res)=>{
    try{
      const result=await pool.query([
        'SELECT p.id,p.kind,p.plan_code AS "planCode",',
        'p.duration_days AS "durationDays",p.amount_paise AS "amountPaise",',
        'p.status,p.upi_reference AS "upiReference",',
        'p.paytm_order_id AS "gatewayOrderId",p.gateway_mode AS "gatewayMode",',
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
      await activateVerifiedPayment(client,p,"upi");
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
module.exports={paymentConfig,quote,upiUrl,secureMatch,
  ensureSubscriptionPaymentTables,settleCapturedGateway,
  installPaymentWebhook,installSubscriptionPayments};
