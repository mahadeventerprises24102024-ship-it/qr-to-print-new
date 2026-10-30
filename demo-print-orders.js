"use strict";
// Metadata-only requests: the customer's file NEVER leaves their device.
const {randomBytes,createHash}=require("node:crypto");
const rateLimit=require("express-rate-limit");
const demoLimiter=rateLimit({windowMs:3600000,limit:8,standardHeaders:"draft-7",legacyHeaders:false});
const statusLimiter=rateLimit({windowMs:900000,limit:30,standardHeaders:"draft-7",legacyHeaders:false});
const CODE=/^[a-f0-9]{32}$/;
const ORDER_ID=/^[1-9][0-9]{0,14}$/;
const TOKEN=/^[a-f0-9]{48}$/;
function makeTrackingToken(){
  const token=randomBytes(24).toString("hex");
  return {token,hash:createHash("sha256").update(token).digest("hex")};
}
function trackingHash(token){
  return TOKEN.test(token||"")?createHash("sha256").update(token).digest("hex"):null;
}
async function ensureDemoOrderTables(pool){
  await pool.query([
    "CREATE TABLE IF NOT EXISTS demo_print_requests (",
    "id BIGSERIAL PRIMARY KEY,shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,",
    "file_type VARCHAR(8) NOT NULL CHECK (file_type IN ('pdf','png','jpeg')),",
    "file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),",
    "copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 10),",
    "status VARCHAR(16) NOT NULL DEFAULT 'demo_only',",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ].join(" "));
  await pool.query("ALTER TABLE demo_print_requests ADD COLUMN IF NOT EXISTS tracking_token_hash VARCHAR(64)");
  await pool.query("ALTER TABLE demo_print_requests DROP CONSTRAINT IF EXISTS demo_print_requests_status_check");
  await pool.query([
    "ALTER TABLE demo_print_requests ADD CONSTRAINT demo_print_requests_status_check",
    "CHECK (status IN ('demo_only','reviewed','closed'))"
  ].join(" "));
  await pool.query([
    "CREATE UNIQUE INDEX IF NOT EXISTS demo_print_requests_tracking_hash_unique",
    "ON demo_print_requests(tracking_token_hash) WHERE tracking_token_hash IS NOT NULL"
  ].join(" "));
  await pool.query([
    "CREATE INDEX IF NOT EXISTS demo_print_requests_shop_recent",
    "ON demo_print_requests(shop_id,created_at DESC,id DESC)"
  ].join(" "));
}
function installDemoOrderApis(app,pool){
  app.post("/api/public/shops/:code/demo-orders",demoLimiter,async(req,res)=>{
    const code=req.params.code;
    const {fileType,fileSizeBytes,copies}=req.body||{};
    if(!CODE.test(code||"")||!["pdf","png","jpeg"].includes(fileType)||
       !Number.isInteger(fileSizeBytes)||fileSizeBytes<1||fileSizeBytes>10485760||
       !Number.isInteger(copies)||copies<1||copies>10){
      return res.status(400).json({error:"Invalid test request"});
    }
    try{
      const found=await pool.query("SELECT id FROM shops WHERE public_code = $1",[code]);
      if(!found.rows.length)return res.status(404).json({error:"Shop not found"});
      const count=await pool.query("SELECT COUNT(*)::int AS total FROM demo_print_requests WHERE shop_id = $1",
        [found.rows[0].id]);
      if(count.rows[0].total>=30)return res.status(429).json({error:"Demo limit reached"});
      const tracking=makeTrackingToken();
      const result=await pool.query([
        "INSERT INTO demo_print_requests",
        "(shop_id,file_type,file_size_bytes,copies,tracking_token_hash)",
        "VALUES ($1,$2,$3,$4,$5)",
        'RETURNING id,status,created_at AS "createdAt"'
      ].join(" "),[found.rows[0].id,fileType,fileSizeBytes,copies,tracking.hash]);
      res.set("Cache-Control","no-store");
      return res.status(201).json({
        demoOnly:true,fileUploaded:false,
        message:"Test request saved. File was not uploaded or printed.",
        order:result.rows[0],trackingToken:tracking.token
      });
    }catch(error){
      console.error("Demo order failed:",error);
      return res.status(503).json({error:"Unable to save test request"});
    }
  });
  app.post("/api/public/shops/:code/demo-orders/status",statusLimiter,async(req,res)=>{
    const {orderId,trackingToken}=req.body||{};
    const hash=trackingHash(trackingToken);
    if(!CODE.test(req.params.code||"")||!ORDER_ID.test(String(orderId||""))||!hash){
      return res.status(400).json({error:"Enter a valid demo order ID and tracking code"});
    }
    try{
      const found=await pool.query([
        'SELECT r.id,r.status,r.created_at AS "createdAt"',
        "FROM demo_print_requests r JOIN shops s ON s.id=r.shop_id",
        "WHERE s.public_code=$1 AND r.id=$2 AND r.tracking_token_hash=$3"
      ].join(" "),[req.params.code,String(orderId),hash]);
      res.set("Cache-Control","no-store");
      if(!found.rows.length)return res.status(404).json({error:"Tracking details not found"});
      return res.json({demoOnly:true,fileUploaded:false,order:found.rows[0]});
    }catch(error){
      console.error("Demo status lookup failed:",error);
      return res.status(503).json({error:"Unable to check demo status"});
    }
  });
  app.get("/api/shop/demo-orders",async(req,res)=>{
    if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shop login required"});
    try{
      const orders=await pool.query([
        'SELECT r.id,r.file_type AS "fileType",r.file_size_bytes AS "fileSizeBytes",',
        'r.copies,r.status,r.created_at AS "createdAt"',
        "FROM demo_print_requests r JOIN shop_owners owner ON owner.shop_id=r.shop_id",
        "WHERE owner.id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 30"
      ].join(" "),[req.session.shopOwnerId]);
      res.set("Cache-Control","private, no-store");
      return res.json({demoOnly:true,orders:orders.rows});
    }catch(error){
      console.error("Demo order list failed:",error);
      return res.status(503).json({error:"Unable to load test requests"});
    }
  });
  // Reviewed means owner acknowledged metadata; closed means archived.
  // Neither status implies that a file was uploaded, paid for, or printed.
  app.post("/api/shop/demo-orders/:id/status",async(req,res)=>{
    if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shop login required"});
    if(!ORDER_ID.test(req.params.id||"")||
       !["reviewed","closed"].includes(req.body?.status)){
      return res.status(400).json({error:"Select reviewed or closed for a valid demo order"});
    }
    try{
      const result=await pool.query([
        "UPDATE demo_print_requests r SET status=$3 FROM shop_owners owner",
        "WHERE owner.shop_id=r.shop_id AND owner.id=$1 AND r.id=$2",
        "AND ((r.status='demo_only' AND $3 IN ('reviewed','closed'))",
        "OR (r.status='reviewed' AND $3='closed'))",
        "RETURNING r.id,r.status"
      ].join(" "),[req.session.shopOwnerId,req.params.id,req.body.status]);
      if(!result.rows.length)return res.status(409).json({
        error:"Order not found for this shop or status transition not allowed"
      });
      res.set("Cache-Control","private, no-store");
      return res.json({demoOnly:true,order:result.rows[0],fileUploaded:false});
    }catch(error){
      console.error("Demo order status update failed:",error);
      return res.status(503).json({error:"Could not update demo request"});
    }
  });
}
module.exports={ensureDemoOrderTables,installDemoOrderApis,makeTrackingToken,trackingHash};
