"use strict";
// Owner-confirmed UPI print TEST payments. No gateway confirmation, no auto printing.
const {randomBytes,createHash}=require("node:crypto");
const QRCode=require("qrcode");
const rateLimit=require("express-rate-limit");
const limiter=rateLimit({windowMs:900000,limit:20,standardHeaders:"draft-7",legacyHeaders:false});
const ownerLimiter=rateLimit({windowMs:900000,limit:25,standardHeaders:"draft-7",legacyHeaders:false});
const codePattern=/^[a-f0-9]{32}$/;
const idPattern=/^[1-9][0-9]{0,14}$/;
const tokenPattern=/^[a-f0-9]{48}$/;
function validVpa(value){return typeof value==="string"&&value.length>=5&&value.length<=133&&/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}@[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/.test(value);}
function validPayee(value){return typeof value==="string"&&value===value.trim()&&value.length>=2&&value.length<=70&&!/[\x00-\x1f\x7f<>]/.test(value);}
function rupees(paise){return (Number(paise)/100).toFixed(2);}
function reference(){return "QRTP"+randomBytes(13).toString("hex").toUpperCase();}
function upiUrl(vpa,payee,amount,ref){
  if(!validVpa(vpa)||!validPayee(payee)||!Number.isSafeInteger(amount)||amount<100||amount>250000||!/^QRTP[A-F0-9]{26}$/.test(ref))throw new Error("Invalid UPI quote");
  return "upi://pay?"+new URLSearchParams({pa:vpa,pn:payee,tr:ref,tn:"QR-To-Print TEST "+ref.slice(-8),am:rupees(amount),cu:"INR"}).toString();
}
function hashToken(token){return tokenPattern.test(token||"")?createHash("sha256").update(token).digest("hex"):null;}
function publicPayment(p){
  return {orderId:p.order_id,amountRupees:rupees(p.amount_paise),pagesPerCopy:Number(p.pages_per_copy),
    reference:p.payment_reference,status:p.status,automaticallyVerified:false,
    automaticPrinting:false,testOnly:true};
}
function ownerOnly(req,res,next){if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shop login required"});next();}
async function ensureUpiPrintTables(pool){
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_upi_payment_accounts (",
    "shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,",
    "vpa VARCHAR(133) NOT NULL,payee_name VARCHAR(70) NOT NULL,",
    "enabled BOOLEAN NOT NULL DEFAULT FALSE,",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ].join(" "));
  await pool.query([
    "CREATE TABLE IF NOT EXISTS shop_upi_test_payments (",
    "id BIGSERIAL PRIMARY KEY,shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "order_id BIGINT NOT NULL UNIQUE REFERENCES test_file_orders(id) ON DELETE CASCADE,",
    "payment_reference VARCHAR(30) NOT NULL UNIQUE,",
    "vpa_snapshot VARCHAR(133) NOT NULL,payee_name_snapshot VARCHAR(70) NOT NULL,",
    "pages_per_copy SMALLINT NOT NULL CHECK(pages_per_copy BETWEEN 1 AND 20),",
    "amount_paise INTEGER NOT NULL CHECK(amount_paise BETWEEN 100 AND 250000),",
    "status VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'",
    "CHECK(status IN ('awaiting_payment','customer_claimed','paid_manual','rejected')),",
    "claimed_at TIMESTAMPTZ,",
    "confirmed_by_owner_id BIGINT REFERENCES shop_owners(id) ON DELETE SET NULL,",
    "confirmed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ].join(" "));
  // Remove legacy UTR storage as well as the customer-facing UTR box.
  // Previously collected UTRs are no longer needed for manual bank checks.
  await pool.query("DROP INDEX IF EXISTS upi_test_utr_unique");
  await pool.query("ALTER TABLE shop_upi_test_payments DROP COLUMN IF EXISTS customer_utr");
  await pool.query("CREATE INDEX IF NOT EXISTS upi_test_shop_recent ON shop_upi_test_payments(shop_id,id DESC)");
  // This is shop-owner-declared metadata, not Paytm/device verification.
  // Existing UPI recipients keep their current settings unchanged.
  await pool.query("ALTER TABLE shop_upi_payment_accounts ADD COLUMN IF NOT EXISTS payment_channel VARCHAR(20) NOT NULL DEFAULT 'regular_upi'");
  await pool.query("ALTER TABLE shop_upi_payment_accounts ADD COLUMN IF NOT EXISTS soundbox_mapping_declared BOOLEAN NOT NULL DEFAULT FALSE");
}
function installUpiPrintPayments(app,pool){
  app.get("/api/shop/upi-payment/account",ownerOnly,async(req,res)=>{
    try{
      const q=await pool.query([
        "SELECT a.vpa,a.payee_name AS \"payeeName\",a.enabled,",
        "a.payment_channel AS \"paymentChannel\",",
        "a.soundbox_mapping_declared AS \"soundboxMappingDeclared\"",
        "FROM shop_upi_payment_accounts a JOIN shop_owners o ON o.shop_id=a.shop_id",
        "WHERE o.id=$1"
      ].join(" "),[req.session.shopOwnerId]);
      res.set("Cache-Control","private, no-store");
      res.json({configured:q.rows.length>0,account:q.rows[0]||null,manualVerification:true});
    }catch(e){console.error("UPI recipient",e);res.status(503).json({error:"UPI configuration unavailable"});}
  });
  app.put("/api/shop/upi-payment/account",ownerOnly,ownerLimiter,async(req,res)=>{
    const {vpa,payeeName,enabled,confirmedRecipient}=req.body||{};
    const paymentChannel=req.body?.paymentChannel??"regular_upi";
    const soundboxMappingDeclared=req.body?.soundboxMappingDeclared===true;
    if(!validVpa(vpa)||!validPayee(payeeName)||typeof enabled!=="boolean"||confirmedRecipient!==true||
      !["regular_upi","paytm_soundbox"].includes(paymentChannel)||
      (paymentChannel==="paytm_soundbox"&&enabled&&!soundboxMappingDeclared)){

      return res.status(400).json({error:"Enter your valid UPI ID and recipient name and confirm its ownership"});
    }
    try{
      const q=await pool.query([
        "INSERT INTO shop_upi_payment_accounts(shop_id,vpa,payee_name,enabled,payment_channel,soundbox_mapping_declared)",
        "SELECT shop_id,$2,$3,$4,$5,$6 FROM shop_owners WHERE id=$1",
        "ON CONFLICT(shop_id) DO UPDATE SET vpa=EXCLUDED.vpa,payee_name=EXCLUDED.payee_name,",
        "enabled=EXCLUDED.enabled,payment_channel=EXCLUDED.payment_channel,",
        "soundbox_mapping_declared=EXCLUDED.soundbox_mapping_declared,updated_at=NOW()",
        "RETURNING vpa,payee_name AS \"payeeName\",enabled,",
        "payment_channel AS \"paymentChannel\",",
        "soundbox_mapping_declared AS \"soundboxMappingDeclared\""
      ].join(" "),[req.session.shopOwnerId,vpa,payeeName,enabled,paymentChannel,
        paymentChannel==="paytm_soundbox"&&soundboxMappingDeclared]);
      if(!q.rows.length)return res.status(404).json({error:"Shop not found"});
      res.set("Cache-Control","private, no-store");
      res.json({account:q.rows[0],
        message:"Owner must manually verify actual bank receipt. Paytm Soundbox alerts are issued by Paytm for payments to its linked merchant QR, not by this website.",
        paytmSoundboxDeviceConnectedByWebsite:false,
        paymentAutomaticallyVerified:false,automaticPrinting:false});
    }catch(e){console.error("Save UPI",e);res.status(503).json({error:"Unable to save shop UPI ID"});}
  });
  app.post("/api/shop/test-file-orders/:id/upi/quote",ownerOnly,ownerLimiter,async(req,res)=>{
    const id=req.params.id,pages=req.body?.pagesPerCopy;
    if(!idPattern.test(id||"")||!Number.isInteger(pages)||pages<1||pages>20)return res.status(400).json({error:"Enter actual pages per copy (1–20)"});
    try{
      const q=await pool.query([
        "SELECT o.id,o.shop_id,o.copies,o.print_mode,o.document_kind,",
        "COALESCE(r.bw_paise,300) AS bw_paise,COALESCE(r.color_paise,1000) AS color_paise,",
        "COALESCE(r.aadhaar_bw_paise,500) AS aadhaar_bw_paise,",
        "a.vpa,a.payee_name FROM test_file_orders o",
        "JOIN shop_owners owner ON owner.shop_id=o.shop_id",
        "JOIN shop_upi_payment_accounts a ON a.shop_id=o.shop_id AND a.enabled=TRUE",
        "LEFT JOIN shop_print_rates r ON r.shop_id=o.shop_id",
        "WHERE owner.id=$1 AND o.id=$2 AND o.status='accepted'",
        "AND o.file_deleted_at IS NULL",
        "AND o.created_at > NOW()-INTERVAL '24 hours'"
      ].join(" "),[req.session.shopOwnerId,id]);
      if(!q.rows.length)return res.status(409).json({error:"Configure shop UPI ID and accept an unexpired TEST file first"});
      const order=q.rows[0];
      // Dummy front/back sample is already one combined A4 TEST sheet. Apply
      // the configured Aadhaar-card B&W per-copy rate, not the B&W page rate.
      // Real Aadhaar uploads remain unsupported by this TEST endpoint.
      const dummyCard=order.document_kind==="dummy_card_front_back";
      if(dummyCard&&pages!==1)return res.status(400).json({
        error:"DUMMY front/back card is one combined TEST layout. Enter exactly 1 page per copy."
      });
      const unitRate=order.print_mode==="color"?Number(order.color_paise):
        (dummyCard?Number(order.aadhaar_bw_paise):Number(order.bw_paise));
      const amount=Number(order.copies)*pages*unitRate;
      if(!Number.isSafeInteger(amount)||amount<100||amount>250000)return res.status(400).json({error:"Total TEST amount must be ₹1–₹2500"});
      const result=await pool.query([
        "INSERT INTO shop_upi_test_payments",
        "(shop_id,order_id,payment_reference,vpa_snapshot,payee_name_snapshot,pages_per_copy,amount_paise)",
        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
        "ON CONFLICT(order_id) DO NOTHING",
        "RETURNING order_id,amount_paise,pages_per_copy,payment_reference,status"
      ].join(" "),[order.shop_id,id,reference(),order.vpa,order.payee_name,pages,amount]);
      if(!result.rows.length)return res.status(409).json({error:"This order already has a UPI payment request; duplicate charges are disabled"});
      res.set("Cache-Control","private, no-store");
      res.status(201).json({payment:publicPayment(result.rows[0])});
    }catch(e){console.error("UPI quote",e);res.status(503).json({error:"Unable to create UPI TEST quote"});}
  });
  async function lookupCustomer(req){
    if(!codePattern.test(req.params.code||"")||!idPattern.test(req.params.id||""))return null;
    const hash=hashToken(req.body?.trackingToken);
    if(!hash)return null;
    const q=await pool.query([
      "SELECT p.*,o.status AS order_status FROM shop_upi_test_payments p",
      "JOIN test_file_orders o ON o.id=p.order_id AND o.shop_id=p.shop_id",
      "JOIN shops s ON s.id=p.shop_id",
      "WHERE s.public_code=$1 AND o.id=$2 AND o.tracking_token_hash=$3",
      "AND o.created_at > NOW()-INTERVAL '24 hours'",
      "AND o.file_deleted_at IS NULL"
    ].join(" "),[req.params.code,req.params.id,hash]);
    return q.rows[0]||null;
  }
  app.post("/api/public/shops/:code/test-file-orders/:id/upi/details",limiter,async(req,res)=>{
    if(!codePattern.test(req.params.code||"")||!idPattern.test(req.params.id||"")||!hashToken(req.body?.trackingToken))return res.status(400).json({error:"Valid private tracking code required"});
    try{
      const p=await lookupCustomer(req);
      if(!p)return res.status(404).json({error:"Ask shop owner to set UPI payment amount for this TEST order"});
      const payment=publicPayment(p);
      if(["awaiting_payment","rejected"].includes(p.status)){
        const intent=upiUrl(p.vpa_snapshot,p.payee_name_snapshot,Number(p.amount_paise),p.payment_reference);
        payment.vpa=p.vpa_snapshot;payment.payeeName=p.payee_name_snapshot;payment.upiUrl=intent;
        payment.qrDataUri=await QRCode.toDataURL(intent,{width:270,margin:2,errorCorrectionLevel:"M"});
      }
      res.set("Cache-Control","no-store");
      res.json({payment});
    }catch(e){console.error("UPI details",e);res.status(503).json({error:"Unable to get UPI payment QR"});}
  });
  app.post("/api/public/shops/:code/test-file-orders/:id/upi/claim",limiter,async(req,res)=>{
    if(!codePattern.test(req.params.code||"")||!idPattern.test(req.params.id||"")||
       !hashToken(req.body?.trackingToken)){
      return res.status(400).json({error:"Valid TEST order and private tracking code required"});
    }
    try{
      const p=await lookupCustomer(req);
      if(!p||p.order_status!=="accepted")return res.status(409).json({error:"TEST order missing or not accepted"});
      const q=await pool.query([
        "UPDATE shop_upi_test_payments SET status='customer_claimed',",
        "claimed_at=NOW()",
        "WHERE id=$1 AND status IN ('awaiting_payment','rejected')",
        "RETURNING order_id,amount_paise,pages_per_copy,payment_reference,status"
      ].join(" "),[p.id]);
      if(!q.rows.length)return res.status(409).json({error:"This payment claim was already submitted; do not pay twice"});
      res.set("Cache-Control","no-store");
      res.json({payment:publicPayment(q.rows[0]),message:"Customer says they paid. NOT verified. Shop owner must check actual bank credit."});
    }catch(e){
      console.error("UPI claim",e);res.status(503).json({error:"Unable to notify shop of payment"});
    }
  });
  app.get("/api/shop/upi-payment/orders",ownerOnly,async(req,res)=>{
    try{
      const q=await pool.query([
        "SELECT p.order_id,p.payment_reference,p.amount_paise,p.pages_per_copy,",
        "p.status,p.claimed_at,p.confirmed_at",
        "FROM shop_upi_test_payments p JOIN shop_owners o ON o.shop_id=p.shop_id",
        "WHERE o.id=$1 ORDER BY p.id DESC LIMIT 50"
      ].join(" "),[req.session.shopOwnerId]);
      res.set("Cache-Control","private, no-store");
      res.json({manualVerification:true,automaticPrinting:false,
        payments:q.rows.map(p=>({...publicPayment(p),
          claimedAt:p.claimed_at||null,
          confirmedAt:p.confirmed_at||null}))});
    }catch(e){console.error("UPI inbox",e);res.status(503).json({error:"UPI TEST inbox unavailable"});}
  });
  // Owner-scoped print permission for SAMPLE orders. Existing UPI quotes
  // lock the browser Print action until actual bank credit is owner-confirmed.
  // An order with no UPI quote can use the owner's existing cash/manual-test path.
  app.get("/api/shop/test-file-orders/:id/print-permission",ownerOnly,async(req,res)=>{
    if(!idPattern.test(req.params.id||""))
      return res.status(400).json({error:"Invalid SAMPLE order"});
    try{
      const q=await pool.query([
        "SELECT o.status AS order_status,p.status AS upi_status",
        "FROM test_file_orders o",
        "JOIN shop_owners owner ON owner.shop_id=o.shop_id",
        "LEFT JOIN shop_upi_test_payments p ON p.order_id=o.id AND p.shop_id=o.shop_id",
        "WHERE owner.id=$1 AND o.id=$2",
        "AND o.created_at > NOW()-INTERVAL '24 hours' AND o.file_deleted_at IS NULL"
      ].join(" "),[req.session.shopOwnerId,req.params.id]);
      res.set("Cache-Control","private, no-store");
      if(!q.rows.length)return res.status(404).json({error:"Sample order missing, expired or not your shop"});
      const row=q.rows[0];
      const hasUpiQuote=row.upi_status!==null&&row.upi_status!==undefined;
      const allowed=row.order_status==="accepted"&&
        (!hasUpiQuote||row.upi_status==="paid_manual");
      return res.json({
        canPrint:allowed,accepted:row.order_status==="accepted",
        upiQuoteExists:hasUpiQuote,upiStatus:hasUpiQuote?row.upi_status:null,
        requiresManualBankConfirmation:hasUpiQuote&&row.upi_status!=="paid_manual",
        paymentMode:hasUpiQuote?"upi_quote":"manual_test",
        sampleOnly:true,automaticPrinting:false
      });
    }catch(error){
      console.error("Sample print permission check",error);
      res.status(503).json({error:"Cannot check payment state for this SAMPLE order"});
    }
  });
  // Restrict automatic print-DIALOG launch to a fresh accepted TEST file
  // whose bank receipt was explicitly confirmed by THIS shop owner. No file
  // or printer command is returned by this endpoint.
  app.get("/api/shop/upi-payment/orders/:id/print-ready",ownerOnly,async(req,res)=>{
    if(!idPattern.test(req.params.id||""))
      return res.status(400).json({error:"Invalid TEST order"});
    try{
      const q=await pool.query([
        "SELECT o.id FROM test_file_orders o",
        "JOIN shop_upi_test_payments p ON p.order_id=o.id AND p.shop_id=o.shop_id",
        "JOIN shop_owners owner ON owner.shop_id=o.shop_id",
        "WHERE owner.id=$1 AND o.id=$2 AND o.status='accepted'",
        "AND p.status='paid_manual' AND o.created_at > NOW()-INTERVAL '24 hours'",
        "AND o.file_deleted_at IS NULL"
      ].join(" "),[req.session.shopOwnerId,req.params.id]);
      res.set("Cache-Control","private, no-store");
      if(!q.rows.length)return res.status(409).json({
        error:"This shop has not confirmed bank payment for a fresh accepted TEST file"
      });
      return res.json({ready:true,manualBankConfirmation:true,
        openPrintDialogOnly:true,automaticPrinting:false});
    }catch(e){
      console.error("UPI print dialog authorization",e);
      return res.status(503).json({error:"Unable to verify payment before opening print dialog"});
    }
  });
  app.post("/api/shop/upi-payment/orders/:id/decision",ownerOnly,ownerLimiter,async(req,res)=>{
    if(!idPattern.test(req.params.id||"")||!["paid_manual","rejected"].includes(req.body?.decision))return res.status(400).json({error:"Invalid UPI decision"});
    const paid=req.body.decision==="paid_manual";
    if(paid&&(req.body.confirmedBankCredit!==true||!Number.isInteger(req.body.confirmedAmountPaise))){
      return res.status(400).json({error:"Confirm bank credit and exact amount first"});
    }
    try{
      const parts=[
        "UPDATE shop_upi_test_payments p SET",
        paid?"status='paid_manual',confirmed_at=NOW(),confirmed_by_owner_id=$1":"status='rejected'",
        "FROM shop_owners o WHERE o.id=$1 AND o.shop_id=p.shop_id AND p.order_id=$2",
        "AND p.status='customer_claimed'",
        paid?"AND p.amount_paise=$3":"",
        "RETURNING p.order_id,p.amount_paise,p.pages_per_copy,p.payment_reference,p.status"
      ];
      const args=paid?[req.session.shopOwnerId,req.params.id,req.body.confirmedAmountPaise]:[req.session.shopOwnerId,req.params.id];
      const q=await pool.query(parts.join(" "),args);
      if(!q.rows.length)return res.status(409).json({error:"Claim not found, wrong amount, or already reviewed"});
      res.set("Cache-Control","private, no-store");
      res.json({payment:publicPayment(q.rows[0]),automaticPrinting:false,
        printDialogUrl: paid ? "/shop-print-preview.html?order="+
          encodeURIComponent(req.params.id)+"&autoPrint=1" : null,
        message:paid?"Shop verified bank credit. Open the print preview; only the browser print dialog is triggered, not the printer itself.":"Customer payment claim rejected"});
    }catch(e){console.error("UPI decision",e);res.status(503).json({error:"Unable to review UPI claim"});}
  });
}
module.exports={validVpa,validPayee,rupees,reference,upiUrl,hashToken,publicPayment,ensureUpiPrintTables,installUpiPrintPayments};
