"use strict";
// Cash is NEVER paid just because the customer selected "Cash".
// Only an authenticated shop owner can quote a price and attest that
// physical cash was received. A paid cash PHOTO is eligible for the
// paired auto-print agent only if the shop explicitly enabled Auto Print.
const crypto=require("node:crypto");
const rateLimit=require("express-rate-limit");
const idPattern=/^[1-9][0-9]{0,14}$/;
const codePattern=/^[a-f0-9]{32}$/;
const trackingPattern=/^[a-f0-9]{48}$/;
const ownerLimiter=rateLimit({windowMs:15*60*1000,limit:25,standardHeaders:"draft-7",legacyHeaders:false});
const guestLimiter=rateLimit({windowMs:15*60*1000,limit:25,standardHeaders:"draft-7",legacyHeaders:false});
const owner=(req,res,next)=>{
  if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shopkeeper login required"});
  next();
};
const publicCash=p=>({orderId:p.order_id,pagesPerCopy:Number(p.pages_per_copy),
  amountRupees:(Number(p.amount_paise)/100).toFixed(2),
  status:p.status,verifiedByShopkeeper:p.status==="paid",automaticPaymentVerification:false});
async function ensureCashPrintTables(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS shop_cash_print_payments(
    id BIGSERIAL PRIMARY KEY,
    shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    order_id BIGINT NOT NULL UNIQUE REFERENCES test_file_orders(id) ON DELETE CASCADE,
    pages_per_copy SMALLINT NOT NULL CHECK (pages_per_copy BETWEEN 1 AND 20),
    amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 100 AND 250000),
    status VARCHAR(12) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','paid')),
    confirmed_by_owner_id BIGINT REFERENCES shop_owners(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS shop_cash_recent ON shop_cash_print_payments(shop_id,id DESC)");
}
function installCashPrintPayments(app,pool){
  app.post("/api/shop/test-file-orders/:id/cash/quote",owner,ownerLimiter,async(req,res)=>{
    const pages=req.body?.pagesPerCopy;
    if(!idPattern.test(req.params.id||"")||!Number.isInteger(pages)||pages<1||pages>20)
      return res.status(400).json({error:"Enter pages per copy (1–20)"});
    try{
      const q=await pool.query([
        "SELECT o.shop_id,o.copies,o.print_mode,",
        "COALESCE(r.bw_paise,300) AS bw_paise,",
        "COALESCE(r.color_paise,1000) AS color_paise",
        "FROM test_file_orders o",
        "JOIN shop_owners owner ON owner.shop_id=o.shop_id",
        "LEFT JOIN shop_print_rates r ON r.shop_id=o.shop_id",
        "WHERE owner.id=$1 AND o.id=$2 AND o.payment_method='cash'",
        "AND o.status='accepted' AND o.file_deleted_at IS NULL",
        "AND o.created_at>NOW()-INTERVAL '24 hours'"
      ].join(" "),[req.session.shopOwnerId,req.params.id]);
      if(!q.rows.length)return res.status(409).json({
        error:"Only fresh, accepted Cash orders from your own shop can be quoted"});
      const o=q.rows[0];
      const unit=Number(o.print_mode==="color"?o.color_paise:o.bw_paise);
      const amount=Number(o.copies)*pages*unit;
      if(!Number.isSafeInteger(amount)||amount<100||amount>250000)
        return res.status(400).json({error:"Cash amount must be ₹1–₹2500"});
      const result=await pool.query([
        "INSERT INTO shop_cash_print_payments",
        "(shop_id,order_id,pages_per_copy,amount_paise)",
        "VALUES ($1,$2,$3,$4) ON CONFLICT(order_id) DO NOTHING",
        "RETURNING order_id,pages_per_copy,amount_paise,status"
      ].join(" "),[o.shop_id,req.params.id,pages,amount]);
      if(!result.rows.length)return res.status(409).json({
        error:"Cash price already set for this order; do not charge twice"});
      res.set("Cache-Control","private, no-store");
      return res.status(201).json({payment:publicCash(result.rows[0]),
        message:"Collect exact cash amount in person. Selecting Cash is not proof of payment."});
    }catch(e){
      console.error("Cash quote",e?.name);
      return res.status(503).json({error:"Unable to set cash price"});
    }
  });
  app.get("/api/shop/test-file-orders/:id/cash/status",owner,async(req,res)=>{
    if(!idPattern.test(req.params.id||""))return res.status(400).json({error:"Invalid order"});
    try{
      const q=await pool.query([
        "SELECT p.order_id,p.pages_per_copy,p.amount_paise,p.status",
        "FROM shop_cash_print_payments p",
        "JOIN shop_owners owner ON owner.shop_id=p.shop_id",
        "WHERE owner.id=$1 AND p.order_id=$2"
      ].join(" "),[req.session.shopOwnerId,req.params.id]);
      res.set("Cache-Control","private, no-store");
      return res.json({payment:q.rows.length?publicCash(q.rows[0]):null});
    }catch(e){console.error("Cash status",e?.name);return res.status(503).json({error:"Cash status unavailable"});}
  });
  app.post("/api/shop/test-file-orders/:id/cash/confirm",owner,ownerLimiter,async(req,res)=>{
    if(!idPattern.test(req.params.id||"")||req.body?.confirmedCashReceived!==true||
       !Number.isInteger(req.body?.confirmedAmountPaise)||
       req.body.confirmedAmountPaise<100)return res.status(400).json({
         error:"Confirm receipt of the exact cash amount in person"});
    try{
      const q=await pool.query([
        "UPDATE shop_cash_print_payments p",
        "SET status='paid',confirmed_at=NOW(),confirmed_by_owner_id=$1",
        "FROM shop_owners owner,test_file_orders o",
        "WHERE owner.id=$1 AND owner.shop_id=p.shop_id",
        "AND o.id=p.order_id AND o.shop_id=p.shop_id",
        "AND o.payment_method='cash' AND o.status='accepted'",
        "AND o.file_deleted_at IS NULL",
        "AND o.created_at>NOW()-INTERVAL '24 hours'",
        "AND p.order_id=$2 AND p.status='pending' AND p.amount_paise=$3",
        "RETURNING p.order_id,p.pages_per_copy,p.amount_paise,p.status"
      ].join(" "),[req.session.shopOwnerId,req.params.id,req.body.confirmedAmountPaise]);
      if(!q.rows.length)return res.status(409).json({
        error:"Cash quote missing, wrong amount, already confirmed or order unavailable"});
      res.set("Cache-Control","private, no-store");
      return res.json({payment:publicCash(q.rows[0]),
        message:"Cash received confirmed by this shopkeeper. Eligible photos can enter Auto Print Queue when enabled; PDFs stay manual."});
    }catch(e){console.error("Confirm cash",e?.name);return res.status(503).json({error:"Cash confirmation unavailable"});}
  });
  app.post("/api/public/shops/:code/test-file-orders/:id/cash/status",guestLimiter,async(req,res)=>{
    if(!codePattern.test(req.params.code||"")||!idPattern.test(req.params.id||"")||
       !trackingPattern.test(req.body?.trackingToken||""))
      return res.status(400).json({error:"Valid order and tracking code required"});
    const hash=crypto.createHash("sha256").update(req.body.trackingToken).digest("hex");
    try{
      const q=await pool.query([
        "SELECT o.id, o.status AS order_status,",
        "p.order_id,p.pages_per_copy,p.amount_paise,p.status",
        "FROM test_file_orders o",
        "JOIN shops s ON s.id=o.shop_id",
        "LEFT JOIN shop_cash_print_payments p ON p.order_id=o.id AND p.shop_id=o.shop_id",
        "WHERE s.public_code=$1 AND o.id=$2 AND o.tracking_token_hash=$3",
        "AND o.payment_method='cash'",
        "AND o.created_at>NOW()-INTERVAL '24 hours' AND o.file_deleted_at IS NULL"
      ].join(" "),[req.params.code,req.params.id,hash]);
      if(!q.rows.length)return res.status(404).json({error:"Cash order unavailable"});
      res.set("Cache-Control","private, no-store");
      return res.json({
        orderStatus:q.rows[0].order_status,
        payment:q.rows[0].order_id?publicCash(q.rows[0]):null,
        payAtShop:true,customerCannotConfirmCash:true
      });
    }catch(e){console.error("Customer cash status",e?.name);return res.status(503).json({error:"Cash status unavailable"});}
  });
}
module.exports={ensureCashPrintTables,installCashPrintPayments,publicCash};
