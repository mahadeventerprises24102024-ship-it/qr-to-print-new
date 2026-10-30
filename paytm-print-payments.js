"use strict";

// Paytm payment gateway SANDBOX only for explicitly owner-approved,
// disposable non-sensitive TEST print orders. Real customer document printing
// and financial settlement are NOT enabled.
const { randomBytes, createHash } = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const PaytmChecksum = require("paytmchecksum");

const SHOP_CODE=/^[a-f0-9]{32}$/;
const ORDER_ID=/^[1-9][0-9]{0,14}$/;
const TRACK_CODE=/^[a-f0-9]{48}$/;
const STAGE_GATEWAY="https://securestage.paytmpayments.com";
const DEFAULT_CALLBACK="https://qr-to-print-new.onrender.com";
const MAX_QUOTE_PAISE=250000; // ₹2500 maximum SANDBOX quote
const limiter=rateLimit({
  windowMs:15*60*1000,limit:15,standardHeaders:"draft-7",legacyHeaders:false,
  message:{error:"Too many Paytm TEST requests. Please try later."}
});

function stageConfig(env=process.env){
  const mid=typeof env.PAYTM_MID==="string" ? env.PAYTM_MID.trim() : "";
  const merchantKey=typeof env.PAYTM_MERCHANT_KEY==="string" ? env.PAYTM_MERCHANT_KEY : "";
  const websiteName=typeof env.PAYTM_WEBSITE_NAME==="string" && env.PAYTM_WEBSITE_NAME ?
    env.PAYTM_WEBSITE_NAME.trim() : "WEBSTAGING";
  const rawBase=env.PAYTM_CALLBACK_BASE_URL || DEFAULT_CALLBACK;
  let validBase=false,base="";
  try{
    const url=new URL(rawBase);
    validBase=url.protocol==="https:"&&!url.username&&!url.password&&
      url.pathname==="/"&&!url.search&&!url.hash&&url.hostname.includes(".")&&
      !["localhost","127.0.0.1"].includes(url.hostname);
    if(validBase)base=url.origin;
  }catch{/* Invalid callback origin must fail closed. */}
  const enabled=env.PAYTM_TEST_ENABLED==="true"&&
    /^[A-Za-z0-9]{8,30}$/.test(mid)&&merchantKey.length>=16&&merchantKey.length<=128&&
    /^[A-Za-z0-9_]{3,40}$/.test(websiteName)&&validBase;
  return {enabled,mid,merchantKey,websiteName,base};
}
function rupees(paise){
  return (paise/100).toFixed(2);
}
function amountMatches(value,paise){
  return typeof value==="string" && /^\d{1,10}\.\d{2}$/.test(value) &&
    Number.isSafeInteger(paise) && Number(value.replace(".",""))===paise;
}
function trackingHash(token){
  return TRACK_CODE.test(token||"") ?
    createHash("sha256").update(token).digest("hex") : null;
}
function makeMerchantOrderId(){
  return "QRTPTEST_"+randomBytes(16).toString("hex").toUpperCase();
}
async function paytmPost(endpoint,body,cfg,doFetch=fetch){
  const requestBody=JSON.stringify(body);
  const signature=await PaytmChecksum.generateSignature(requestBody,cfg.merchantKey);
  const response=await doFetch(STAGE_GATEWAY+endpoint,{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({body,head:{signature}}),
    signal:AbortSignal.timeout(12000),
    redirect:"error"
  });
  if(!response.ok)throw new Error("Paytm TEST gateway temporarily unavailable");
  const reply=await response.json();
  if(!reply||typeof reply!=="object"||!reply.body||!reply.head||
     typeof reply.head.signature!=="string"){
    throw new Error("Unverified Paytm response");
  }
  const valid=await PaytmChecksum.verifySignature(
    JSON.stringify(reply.body),cfg.merchantKey,reply.head.signature
  );
  if(valid!==true)throw new Error("Invalid Paytm response signature");
  return reply.body;
}
async function statusFromPaytm(record,cfg,doFetch){
  const result=await paytmPost("/v3/order/status",
    {mid:cfg.mid,orderId:record.merchant_order_id},cfg,doFetch);
  if(result.mid!==cfg.mid||result.orderId!==record.merchant_order_id||
     !amountMatches(result.txnAmount,Number(record.amount_paise))){
    throw new Error("Paytm transaction amount, MID or order mismatch");
  }
  const status=result.resultInfo?.resultStatus;
  if(status==="TXN_SUCCESS"&&result.resultInfo?.resultCode==="01"&&
     typeof result.txnId==="string"&&/^[A-Za-z0-9_-]{6,80}$/.test(result.txnId)){
    return {status:"paid",txnId:result.txnId};
  }
  if(status==="TXN_FAILURE")return {status:"failed"};
  return {status:"pending"};
}
async function reconcile(pool,record,cfg,doFetch){
  if(record.status==="paid")return "paid";
  if(!["initiating","pending","unknown","failed"].includes(record.status))return record.status;
  const current=await statusFromPaytm(record,cfg,doFetch);
  if(current.status==="paid"){
    // Atomic compare and update. Unique gateway txn ID prevents double accounting.
    // Merely verified payment NEVER causes any print job here.
    const changed=await pool.query([
      "UPDATE shop_paytm_test_payments SET status='paid',",
      "paytm_txn_id=$2, verified_at=NOW()",
      "WHERE merchant_order_id=$1 AND status <> 'paid'",
      "RETURNING id"
    ].join(" "),[record.merchant_order_id,current.txnId]);
    if(!changed.rows.length)return "paid";
    return "paid";
  }
  if(current.status==="failed"){
    await pool.query(
      "UPDATE shop_paytm_test_payments SET status='failed' WHERE merchant_order_id=$1 AND status<>'paid'",
      [record.merchant_order_id]
    );
  }
  return current.status;
}
async function ensurePaytmTestTables(pool){
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_paytm_test_payments (",
    "id BIGSERIAL PRIMARY KEY,",
    "shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "order_id BIGINT NOT NULL UNIQUE REFERENCES test_file_orders(id) ON DELETE CASCADE,",
    "merchant_order_id VARCHAR(50) NOT NULL UNIQUE,",
    "pages_per_copy SMALLINT NOT NULL CHECK (pages_per_copy BETWEEN 1 AND 20),",
    "amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 100 AND 250000),",
    "status VARCHAR(16) NOT NULL DEFAULT 'quoted'",
    "CHECK (status IN ('quoted','initiating','pending','unknown','failed','paid')),",
    "paytm_txn_id VARCHAR(80) UNIQUE,",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "verified_at TIMESTAMPTZ",
    ")"
  ].join(" "));
  await pool.query(
    "CREATE INDEX IF NOT EXISTS paytm_test_shop_recent ON shop_paytm_test_payments(shop_id,created_at DESC)"
  );
}
function ownerOnly(req,res,next){
  if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shop login required"});
  next();
}
function validPath(req){
  return SHOP_CODE.test(req.params.code||"")&&ORDER_ID.test(req.params.id||"");
}
function safePaymentView(row){
  return {
    orderId:row.order_id,
    amountRupees:rupees(Number(row.amount_paise)),
    pagesPerCopy:Number(row.pages_per_copy),
    status:row.status,
    testOnly:true,
    automaticPrinting:false
  };
}

function installPaytmTestPayments(app,pool,env=process.env,doFetch=fetch){
  const cfg=stageConfig(env);
  app.get("/api/paytm-print/config",(req,res)=>{
    res.set("Cache-Control","no-store");
    res.json({enabled:cfg.enabled,environment:"sandbox",realMoney:false,
      printOnPayment:false,requiresShopReview:true});
  });

  // Shop owner FIRST reviews a safe sample and sets the verified page count.
  // Rates and copies come exclusively from the database, never the visitor.
  app.post("/api/shop/test-file-orders/:id/paytm/quote",
    ownerOnly,limiter,async(req,res)=>{
      if(!cfg.enabled)return res.status(503).json({error:"Paytm SANDBOX not configured"});
      const id=req.params.id;
      const pages=req.body?.pagesPerCopy;
      if(!ORDER_ID.test(id||"")||!Number.isInteger(pages)||pages<1||pages>20){
        return res.status(400).json({error:"Enter reviewed page count, 1–20"});
      }
      try{
        const result=await pool.query([
          "SELECT o.id,o.shop_id,o.copies,o.print_mode,",
          "COALESCE(r.bw_paise,300) AS bw_paise,",
          "COALESCE(r.color_paise,1000) AS color_paise",
          "FROM test_file_orders o",
          "JOIN shop_owners owner ON owner.shop_id=o.shop_id",
          "LEFT JOIN shop_print_rates r ON r.shop_id=o.shop_id",
          "WHERE owner.id=$1 AND o.id=$2 AND o.status='accepted'",
          "AND o.created_at > NOW()-INTERVAL '24 hours'"
        ].join(" "),[req.session.shopOwnerId,id]);
        if(!result.rows.length)return res.status(409).json({
          error:"Accept a fresh non-sensitive TEST file first"
        });
        const o=result.rows[0];
        const rate=o.print_mode==="color"?Number(o.color_paise):Number(o.bw_paise);
        const amount=Number(o.copies)*pages*rate;
        if(!Number.isSafeInteger(amount)||amount<100||amount>MAX_QUOTE_PAISE){
          return res.status(400).json({error:"TEST quote must be between ₹1 and ₹2500"});
        }
        const merchantId=makeMerchantOrderId();
        const inserted=await pool.query([
          "INSERT INTO shop_paytm_test_payments",
          "(shop_id,order_id,merchant_order_id,pages_per_copy,amount_paise)",
          "VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_id) DO NOTHING",
          "RETURNING order_id,pages_per_copy,amount_paise,status"
        ].join(" "),[o.shop_id,id,merchantId,pages,amount]);
        if(!inserted.rows.length)return res.status(409).json({
          error:"Paytm quote already exists for this TEST order. No duplicate charge can be started."
        });
        res.set("Cache-Control","no-store");
        return res.status(201).json({payment:safePaymentView(inserted.rows[0])});
      }catch(error){
        console.error("Paytm TEST quote failed:",error);
        return res.status(503).json({error:"Could not create Paytm TEST quote"});
      }
    });

  // Guest must prove possession of random shop-specific tracking token.
  async function findGuestPayment(req){
    if(!validPath(req))return null;
    const hash=trackingHash(req.body?.trackingToken);
    if(!hash)return null;
    const found=await pool.query([
      "SELECT p.*,o.status AS order_status",
      "FROM shop_paytm_test_payments p",
      "JOIN test_file_orders o ON o.id=p.order_id AND o.shop_id=p.shop_id",
      "JOIN shops s ON s.id=p.shop_id",
      "WHERE s.public_code=$1 AND o.id=$2 AND o.tracking_token_hash=$3",
      "AND o.created_at > NOW()-INTERVAL '24 hours'"
    ].join(" "),[req.params.code,req.params.id,hash]);
    return found.rows[0]||null;
  }

  app.post("/api/public/shops/:code/test-file-orders/:id/paytm/status",
    limiter,async(req,res)=>{
      if(!validPath(req)||!trackingHash(req.body?.trackingToken))
        return res.status(400).json({error:"Valid order and private tracking token required"});
      try{
        const p=await findGuestPayment(req);
        if(!p)return res.status(404).json({error:"Payment quote not ready"});
        // Never claim paid based on browser input; only Paytm signed status API.
        let status=p.status;
        if(cfg.enabled&&["initiating","pending","unknown","failed"].includes(status))
          status=await reconcile(pool,p,cfg,doFetch);
        res.set("Cache-Control","no-store");
        return res.json({payment:{...safePaymentView(p),status}});
      }catch(error){
        console.error("Paytm TEST payment status failed:",error);
        return res.status(503).json({error:"Could not verify payment with Paytm. Please try later."});
      }
    });

  app.post("/api/public/shops/:code/test-file-orders/:id/paytm/checkout",
    limiter,async(req,res)=>{
      if(!cfg.enabled)return res.status(503).json({error:"Paytm SANDBOX not configured"});
      if(!validPath(req)||!trackingHash(req.body?.trackingToken))
        return res.status(400).json({error:"Valid TEST order and tracking token required"});
      try{
        const payment=await findGuestPayment(req);
        if(!payment||payment.order_status!=="accepted")
          return res.status(409).json({error:"Shop must approve and quote this TEST file before Paytm checkout"});
        if(payment.status!=="quoted")
          return res.status(409).json({
            error:"Paytm checkout has already been requested. Check payment status; do not pay twice."
          });
        // Claim this exact order ONCE before calling provider; no duplicate checkout.
        const claimed=await pool.query([
          "UPDATE shop_paytm_test_payments SET status='initiating'",
          "WHERE id=$1 AND status='quoted' RETURNING id"
        ].join(" "),[payment.id]);
        if(!claimed.rows.length)return res.status(409).json({
          error:"Paytm checkout already started. Do not retry payment blindly."
        });
        const body={
          requestType:"Payment",mid:cfg.mid,websiteName:cfg.websiteName,
          orderId:payment.merchant_order_id,
          callbackUrl:cfg.base+"/api/paytm-print/callback",
          txnAmount:{value:rupees(Number(payment.amount_paise)),currency:"INR"},
          userInfo:{custId:"QRTP_TEST_"+String(payment.order_id)}
        };
        let initiated;
        try{
          initiated=await paytmPost(
            "/theia/api/v1/initiateTransaction?mid="+encodeURIComponent(cfg.mid)+
              "&orderId="+encodeURIComponent(payment.merchant_order_id),
            body,cfg,doFetch
          );
        }catch(error){
          // Unknown provider result: NEVER retry the same order or create a
          // second payment. Reconcile through signed status API instead.
          await pool.query(
            "UPDATE shop_paytm_test_payments SET status='unknown' WHERE id=$1 AND status='initiating'",
            [payment.id]
          );
          throw error;
        }
        if(initiated.resultInfo?.resultStatus!=="S"||
           typeof initiated.txnToken!=="string"||
           initiated.txnToken.length<10||initiated.txnToken.length>8192){
          await pool.query(
            "UPDATE shop_paytm_test_payments SET status='unknown' WHERE id=$1 AND status='initiating'",
            [payment.id]
          );
          return res.status(503).json({error:"Paytm did not provide a valid SANDBOX checkout token"});
        }
        await pool.query(
          "UPDATE shop_paytm_test_payments SET status='pending' WHERE id=$1 AND status='initiating'",
          [payment.id]
        );
        res.set("Cache-Control","no-store");
        return res.json({
          testOnly:true,environment:"sandbox",
          mid:cfg.mid,orderId:payment.merchant_order_id,txnToken:initiated.txnToken,
          hostedUrl:STAGE_GATEWAY+"/theia/api/v1/showPaymentPage?mid="+
            encodeURIComponent(cfg.mid)+"&orderId="+
            encodeURIComponent(payment.merchant_order_id),
          amountRupees:rupees(Number(payment.amount_paise))
        });
      }catch(error){
        console.error("Paytm SANDBOX initiation failed:",error);
        return res.status(503).json({error:"Paytm SANDBOX could not initiate. Do not pay again until status is checked."});
      }
    });

  // Provider form POST has no browser Origin. Require Paytm's callback checksum
  // and a SECOND signed server-to-server status enquiry before recording paid.
  app.post("/api/paytm-print/callback",
    express.urlencoded({extended:false,limit:"6kb",parameterLimit:25}),
    async(req,res)=>{
      res.set("Cache-Control","no-store");
      res.set("Referrer-Policy","no-referrer");
      const body=req.body||{};
      if(!cfg.enabled||!ORDER_ID.test("1")||
         typeof body.ORDERID!=="string"||
         !/^QRTPTEST_[A-F0-9]{32}$/.test(body.ORDERID)||
         body.MID!==cfg.mid||
         typeof body.CHECKSUMHASH!=="string"){
        return res.status(400).send("Invalid Paytm TEST callback");
      }
      const signed={...body};
      delete signed.CHECKSUMHASH;
      try{
        const verified=await PaytmChecksum.verifySignature(signed,cfg.merchantKey,body.CHECKSUMHASH);
        if(verified!==true)return res.status(400).send("Unverified payment callback");
        const found=await pool.query([
          "SELECT * FROM shop_paytm_test_payments WHERE merchant_order_id=$1"
        ].join(" "),[body.ORDERID]);
        if(!found.rows.length)return res.status(404).send("Payment not found");
        await reconcile(pool,found.rows[0],cfg,doFetch);
        // This redirect never itself asserts successful payment.
        return res.redirect(303,"/paytm-print-result.html");
      }catch(error){
        console.error("Paytm TEST callback verification unavailable:",error);
        return res.redirect(303,"/paytm-print-result.html");
      }
    });

  app.get("/api/shop/paytm-print/orders",ownerOnly,async(req,res)=>{
    try{
      const found=await pool.query([
        "SELECT p.order_id,p.amount_paise,p.pages_per_copy,p.status,p.verified_at",
        "FROM shop_paytm_test_payments p",
        "JOIN shop_owners o ON o.shop_id=p.shop_id",
        "WHERE o.id=$1 ORDER BY p.id DESC LIMIT 30"
      ].join(" "),[req.session.shopOwnerId]);
      res.set("Cache-Control","no-store");
      return res.json({testOnly:true,automaticPrinting:false,
        payments:found.rows.map(row=>({...safePaymentView(row),
          verifiedAt:row.verified_at}))});
    }catch(error){
      console.error("Shop Paytm TEST payment listing failed:",error);
      return res.status(503).json({error:"Could not load Paytm TEST payments"});
    }
  });
}

module.exports={
  stageConfig,rupees,amountMatches,trackingHash,makeMerchantOrderId,paytmPost,
  statusFromPaytm,reconcile,ensurePaytmTestTables,installPaytmTestPayments
};
