"use strict";
// Shop opt-in auto-print queue. ONLY server-sanitized, non-sensitive customer
// JPEG photos; never PDF, Aadhaar/PAN, test samples, cash or customer claims.
// Windows spool acceptance is not proof that paper was physically printed.
const {randomBytes,createHash}=require("node:crypto");
const rateLimit=require("express-rate-limit");
const {S3Client,GetObjectCommand}=require("@aws-sdk/client-s3");
const sharp=require("sharp");
const {storageSettings}=require("./private-test-uploads");
const limiter=rateLimit({windowMs:60*1000,limit:45,standardHeaders:"draft-7",legacyHeaders:false});
const idPattern=/^[1-9][0-9]{0,14}$/;
const keyPattern=/^qrpa_[A-Za-z0-9_-]{43}$/;
const leasePattern=/^[a-f0-9]{64}$/;
const digest=value=>createHash("sha256").update(value).digest("hex");
const allowedPhotoSize=2*1024*1024;
function authOwner(req,res,next){
  if(!req.session?.shopOwnerId)return res.status(401).json({error:"Shop login required"});
  next();
}
function agentKey(req){
  if(req.get("origin"))return null;
  const header=req.get("authorization")||"";
  const token=header.startsWith("Bearer ")?header.slice(7):"";
  return keyPattern.test(token)?digest(token):null;
}
async function ensureAutoPrintTables(pool){
  await pool.query("ALTER TABLE shop_print_agents ADD COLUMN IF NOT EXISTS auto_print_enabled BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE shop_print_agents ADD COLUMN IF NOT EXISTS auto_print_enabled_at TIMESTAMPTZ");
  await pool.query(`CREATE TABLE IF NOT EXISTS shop_auto_print_jobs(
    id BIGSERIAL PRIMARY KEY,
    shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    order_id BIGINT NOT NULL UNIQUE REFERENCES test_file_orders(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','claimed','spooled','failed','needs_review')),
    printer_name VARCHAR(100),
    claim_hash CHAR(64),
    claimed_at TIMESTAMPTZ,
    claim_expires_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS shop_auto_print_jobs_recent ON shop_auto_print_jobs(shop_id, created_at DESC)");
}
function installAutoPrint(app,pool,env=process.env,providedStorage=null){
  const cfg=storageSettings(env);
  const storage=providedStorage||(cfg.enabled?new S3Client({
    endpoint:cfg.endpoint,region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey}
  }):null);
  app.get("/api/shop/auto-print/status",authOwner,async(req,res)=>{
    try{
      const query=await pool.query(`
        SELECT a.auto_print_enabled AS "enabled",
          a.preferred_printer_name AS "preferredPrinter",
          (a.last_seen_at > NOW()-INTERVAL '100 seconds') AS "agentOnline",
          a.auto_print_enabled_at AS "enabledAt"
        FROM shop_print_agents a JOIN shop_owners owner ON owner.shop_id=a.shop_id
        WHERE owner.id=$1`,[req.session.shopOwnerId]);
      const jobs=await pool.query(`
        SELECT j.id,j.order_id AS "orderId",j.status,
          j.printer_name AS "printerName",j.created_at AS "createdAt"
        FROM shop_auto_print_jobs j JOIN shop_owners owner ON owner.shop_id=j.shop_id
        WHERE owner.id=$1 ORDER BY j.id DESC LIMIT 15`,[req.session.shopOwnerId]);
      res.set("Cache-Control","private, no-store");
      res.json({available:!!storage,
        settings:query.rows[0]||{enabled:false,preferredPrinter:null,agentOnline:false},
        jobs:jobs.rows,
        onlySanitizedCustomerPhotos:true,
        onlyOwnerConfirmedUPI:true,
        automaticallyRetryUncertainJobs:false});
    }catch(e){console.error("Auto-print status",e?.name);res.status(503).json({error:"Auto-print status unavailable"});}
  });
  app.put("/api/shop/auto-print/settings",authOwner,limiter,async(req,res)=>{
    if(typeof req.body?.enabled!=="boolean")
      return res.status(400).json({error:"Choose Auto Print ON or OFF"});
    if(req.body.enabled&&!storage)return res.status(503).json({error:"Private photo storage is unavailable"});
    try{
      const q=await pool.query(`
        UPDATE shop_print_agents a
        SET auto_print_enabled=$2,
            auto_print_enabled_at=CASE
              WHEN $2=TRUE AND a.auto_print_enabled=FALSE THEN NOW()
              WHEN $2=FALSE THEN NULL
              ELSE a.auto_print_enabled_at END
        FROM shop_owners owner
        WHERE owner.shop_id=a.shop_id AND owner.id=$1
          AND ($2=FALSE OR (
            a.preferred_printer_name IS NOT NULL
            AND a.printer_names ? a.preferred_printer_name
          ))
        RETURNING a.auto_print_enabled AS "enabled",
                  a.preferred_printer_name AS "preferredPrinter"`,
        [req.session.shopOwnerId,req.body.enabled]);
      if(!q.rows.length)return res.status(409).json({
        error:"Pair Windows Agent and save a printer detected on that shop PC before enabling Auto Print"});
      // Disabling cancels unclaimed jobs. Claimed jobs cannot be forcibly
      // stopped after the agent has downloaded bytes; a download gate blocks
      // those not yet fetched.
      if(!req.body.enabled)await pool.query(`
        UPDATE shop_auto_print_jobs j SET status='needs_review'
        FROM shop_owners owner WHERE owner.shop_id=j.shop_id AND owner.id=$1
          AND j.status='queued'`,[req.session.shopOwnerId]);
      res.set("Cache-Control","private, no-store");
      res.json({settings:q.rows[0],autoPrintForNewOwnerVerifiedUPIPhotosOnly:true});
    }catch(e){console.error("Auto-print settings",e?.name);res.status(503).json({error:"Auto Print settings could not be saved"});}
  });
  // Strong bearer auth (the only credential the agent has, no shop cookies).
  // A print claim is single-use; expired claims are NEEDS_REVIEW, never
  // automatically requeued. A crash or lost ACK thus cannot silently print twice.
  app.post("/api/agent/auto-print/claim",limiter,async(req,res)=>{
    const tokenHash=agentKey(req);
    if(!tokenHash)return res.status(401).json({error:"Valid agent authorization required"});
    try{
      // Mark any uncertain attempts permanently manual-review-only.
      await pool.query(`
        UPDATE shop_auto_print_jobs j SET status='needs_review'
        FROM shop_print_agents a
        WHERE a.shop_id=j.shop_id AND a.token_hash=$1
          AND j.status='claimed' AND j.claim_expires_at<NOW()`,[tokenHash]);
      // Queue ONLY new owner-confirmed payments after explicit opt-in.
      await pool.query(`
        INSERT INTO shop_auto_print_jobs(shop_id,order_id,status)
        SELECT o.shop_id,o.id,'queued' FROM test_file_orders o
        JOIN shop_upi_test_payments p ON p.order_id=o.id AND p.shop_id=o.shop_id
        JOIN shop_print_agents a ON a.shop_id=o.shop_id
        WHERE a.token_hash=$1 AND a.auto_print_enabled=TRUE
          AND a.auto_print_enabled_at IS NOT NULL
          AND p.status='paid_manual' AND p.confirmed_by_owner_id IS NOT NULL
          AND p.confirmed_at>=a.auto_print_enabled_at
          AND o.document_kind='customer_photo' AND o.file_type='jpeg'
          AND o.file_size_bytes BETWEEN 8 AND 2097152
          AND o.status='accepted' AND o.file_deleted_at IS NULL
          AND o.created_at>NOW()-INTERVAL '24 hours'
        ON CONFLICT(order_id) DO NOTHING`,[tokenHash]);
      const leaseToken=randomBytes(32).toString("hex");
      const claimed=await pool.query(`
        WITH candidate AS (
          SELECT j.id FROM shop_auto_print_jobs j
          JOIN shop_print_agents a ON a.shop_id=j.shop_id
          JOIN test_file_orders o ON o.id=j.order_id AND o.shop_id=j.shop_id
          JOIN shop_upi_test_payments p ON p.order_id=o.id AND p.shop_id=j.shop_id
          WHERE a.token_hash=$1 AND a.auto_print_enabled=TRUE
            AND a.last_seen_at>NOW()-INTERVAL '100 seconds'
            AND a.preferred_printer_name IS NOT NULL
            AND a.printer_names ? a.preferred_printer_name
            AND j.status='queued'
            AND o.status='accepted' AND o.file_deleted_at IS NULL
            AND o.document_kind='customer_photo' AND o.file_type='jpeg'
            AND o.created_at>NOW()-INTERVAL '24 hours'
            AND p.status='paid_manual' AND p.confirmed_by_owner_id IS NOT NULL
          ORDER BY j.id ASC FOR UPDATE OF j SKIP LOCKED LIMIT 1
        )
        UPDATE shop_auto_print_jobs j
        SET status='claimed',claimed_at=NOW(),
          claim_expires_at=NOW()+INTERVAL '2 minutes',
          claim_hash=$2,printer_name=a.preferred_printer_name
        FROM candidate,shop_print_agents a
        WHERE j.id=candidate.id AND a.shop_id=j.shop_id AND a.token_hash=$1
        RETURNING j.id,j.order_id AS "orderId",j.printer_name AS "printerName",
          (SELECT o.copies FROM test_file_orders o WHERE o.id=j.order_id) AS copies,
          (SELECT o.print_mode FROM test_file_orders o WHERE o.id=j.order_id) AS "printMode"`,
        [tokenHash,digest(leaseToken)]);
      res.set("Cache-Control","private, no-store");
      if(!claimed.rows.length)return res.json({job:null});
      const job=claimed.rows[0];
      return res.json({job:{...job,leaseToken,paperSize:"A4",kind:"sanitized_customer_photo_jpeg"}});
    }catch(e){console.error("Agent auto-print claim",e?.name);res.status(503).json({error:"Unable to check secure print queue"});}
  });
  // Only a currently claimed order can be retrieved by that shop's agent.
  app.get("/api/agent/auto-print/file/:id",limiter,async(req,res)=>{
    const tokenHash=agentKey(req),lease=req.get("x-print-lease")||"";
    if(!tokenHash||!idPattern.test(req.params.id)||!leasePattern.test(lease))
      return res.status(401).json({error:"Authenticated print claim required"});
    if(!storage)return res.status(503).json({error:"Private storage unavailable"});
    try{
      const q=await pool.query(`
        SELECT o.storage_key AS "key",o.file_sha256 AS "hash",
          o.file_size_bytes AS "size",o.print_mode AS "printMode"
        FROM shop_auto_print_jobs j
        JOIN shop_print_agents a ON a.shop_id=j.shop_id
        JOIN test_file_orders o ON o.id=j.order_id AND o.shop_id=j.shop_id
        JOIN shop_upi_test_payments p ON p.order_id=o.id AND p.shop_id=o.shop_id
        WHERE a.token_hash=$1 AND j.id=$2 AND j.claim_hash=$3
          AND j.status='claimed' AND j.claim_expires_at>NOW()
          AND a.auto_print_enabled=TRUE
          AND p.status='paid_manual' AND p.confirmed_by_owner_id IS NOT NULL
          AND o.status='accepted' AND o.document_kind='customer_photo'
          AND o.file_type='jpeg' AND o.file_deleted_at IS NULL
          AND o.file_size_bytes BETWEEN 8 AND 2097152
          AND o.created_at>NOW()-INTERVAL '24 hours'`,
        [tokenHash,req.params.id,digest(lease)]);
      if(!q.rows.length)return res.status(409).json({error:"Print claim expired, canceled or not allowed"});
      const record=q.rows[0];
      const obj=await storage.send(new GetObjectCommand({Bucket:cfg.bucket,Key:record.key}));
      if(Number(obj.ContentLength)>allowedPhotoSize){
        obj.Body?.destroy?.();
        return res.status(503).json({error:"Stored photo is too large"});
      }
      const bytes=Buffer.from(await obj.Body.transformToByteArray());
      if(bytes.length!==Number(record.size)||digest(bytes)!==record.hash||
         bytes.subarray(0,3).toString("hex")!=="ffd8ff")
        return res.status(503).json({error:"Stored photo failed integrity checks"});
      // Normalize B&W requests before Windows driver consumes the picture.
      const printBytes=record.printMode==="bw"?
        await sharp(bytes,{limitInputPixels:8*1024*1024}).grayscale()
          .jpeg({quality:80}).toBuffer():bytes;
      if(printBytes.length>allowedPhotoSize)return res.status(503).json({
        error:"B&W photo exceeds safe print size"});
      res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
        "Content-Security-Policy":"sandbox",
        "Content-Disposition":'attachment; filename="sanitized-photo.jpg"'});
      return res.type("image/jpeg").send(printBytes);
    }catch(e){console.error("Auto-print photo fetch",e?.name);return res.status(503).json({error:"Unable to fetch authorized sanitized photo"});}
  });
  app.post("/api/agent/auto-print/ack/:id",limiter,async(req,res)=>{
    const tokenHash=agentKey(req),lease=req.body?.leaseToken;
    if(!tokenHash||!idPattern.test(req.params.id)||!leasePattern.test(lease)||
      !["spooled","failed"].includes(req.body?.result))
      return res.status(400).json({error:"Valid agent print acknowledgment required"});
    try{
      const q=await pool.query(`
        UPDATE shop_auto_print_jobs j
        SET status=$4,finished_at=NOW()
        FROM shop_print_agents a
        WHERE a.shop_id=j.shop_id AND a.token_hash=$1
          AND j.id=$2 AND j.claim_hash=$3
          AND j.status='claimed' AND j.claim_expires_at>NOW()
        RETURNING j.id,j.status`,
        [tokenHash,req.params.id,digest(lease),req.body.result]);
      res.set("Cache-Control","private, no-store");
      if(!q.rows.length)return res.status(409).json({error:"Claim already handled or expired; manual review required"});
      return res.json({acknowledged:true,status:q.rows[0].status,
        physicalPaperConfirmed:false});
    }catch(e){console.error("Auto-print acknowledgment",e?.name);res.status(503).json({error:"Could not save print outcome"});}
  });
}
module.exports={ensureAutoPrintTables,installAutoPrint,agentKey};
