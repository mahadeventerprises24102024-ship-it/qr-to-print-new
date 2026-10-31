"use strict";

// A deliberately narrow real-customer photo pilot for non-sensitive JPEG/PNG.
// Never accepts raw PDFs or identity documents; no user-controlled image bytes
// are saved to R2. Images are decoded, re-encoded and stripped of metadata.
// This is not a replacement for malware scanning/CDR of sensitive documents.
const {randomBytes,randomUUID,createHash}=require("node:crypto");
const multer=require("multer");
const rateLimit=require("express-rate-limit");
const sharp=require("sharp");
const {
  S3Client,PutObjectCommand,DeleteObjectCommand
}=require("@aws-sdk/client-s3");
const {storageSettings,detectSafeFile}=require("./private-test-uploads");

const MAX_BYTES=2*1024*1024;
const MAX_PIXELS=8*1024*1024;
sharp.concurrency(1);
sharp.cache(false);

async function sanitizeCustomerPhoto(file){
  if(!file || !Buffer.isBuffer(file.buffer) || !["png","jpeg"].includes(detectSafeFile(file))){
    throw new Error("Only valid JPEG/PNG photo files can be submitted");
  }
  // No animated, multi-page or encoded PDF/SVG input is permitted.
  const opts={limitInputPixels:MAX_PIXELS,pages:1,animated:false,
    failOn:"warning",sequentialRead:true,unlimited:false};
  const metadata=await sharp(file.buffer,opts).metadata();
  if(!["png","jpeg"].includes(metadata.format) ||
    !Number.isInteger(metadata.width)||!Number.isInteger(metadata.height) ||
    metadata.width<200||metadata.height<200||
    metadata.width*metadata.height>MAX_PIXELS||
    (metadata.pages!==undefined&&metadata.pages!==1)){
    throw new Error("Photo dimensions or format are not supported");
  }
  // No withMetadata/keepExif: default output strips EXIF, ICC and GPS.
  const pipe=quality=>sharp(file.buffer,opts)
    .rotate()
    .resize({width:2200,height:2200,fit:"inside",withoutEnlargement:true})
    .flatten({background:"#ffffff"})
    .jpeg({quality,chromaSubsampling:"4:4:4"})
    .toBuffer();
  let bytes=await pipe(85);
  if(bytes.length>MAX_BYTES)bytes=await pipe(68);
  if(bytes.length<8||bytes.length>MAX_BYTES){
    throw new Error("Photo could not be reduced safely under 2 MB");
  }
  return bytes;
}
function installCustomerPhotoUploads(app,pool,env=process.env,dependencies={}){
  const cfg=storageSettings(env);
  const storage=cfg.enabled ? (dependencies.storage||new S3Client({
    endpoint:cfg.endpoint,region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey}
  })) : null;
  // Scanner/renderer for arbitrary PDFs is deliberately not used here.
  // No extra production flag turns on sensitive identity document intake.
  const uploader=multer({storage:multer.memoryStorage(),limits:{
    fileSize:MAX_BYTES,files:1,fields:4,parts:5,fieldSize:64
  }});
  const limiter=rateLimit({windowMs:60*60*1000,limit:4,
    standardHeaders:"draft-7",legacyHeaders:false,
    message:{error:"Too many photo uploads. Try again later."}});
  app.get("/api/customer-photo/config",(_req,res)=>{
    res.set("Cache-Control","no-store");
    res.json({enabled:!!storage,photoPilot:true,maxFileBytes:MAX_BYTES,
      acceptedFormats:["image/jpeg","image/png"],pdfAllowed:false,
      identityDocumentsAllowed:false,customerConsentRequired:true,
      privateStorage:true,maximumRetentionHours:24,
      automaticPrinting:false});
  });
  app.post("/api/public/shops/:code/customer-photo-orders",
    limiter,(req,res)=>{
      if(!storage)return res.status(503).json({error:"Private photo storage is unavailable"});
      uploader.single("file")(req,res,async(error)=>{
        if(error)return res.status(error.code==="LIMIT_FILE_SIZE"?413:400).json({
          error:"Choose one JPEG/PNG photo smaller than 2 MB"});
        const code=req.params.code,body=req.body||{};
        const copies=Number(body.copies),printMode=body.printMode;
        if(!/^[a-f0-9]{32}$/.test(code||"")||
          !Number.isInteger(copies)||copies<1||copies>10||
          !["bw","color"].includes(printMode)||
          body.confirmedNonSensitive!=="yes"){
          return res.status(400).json({error:
            "Select print options and confirm that your photo contains no Aadhaar/PAN or other sensitive identity information"});
        }
        let bytes;
        try{bytes=await (dependencies.sanitize||sanitizeCustomerPhoto)(req.file);}
        catch{return res.status(415).json({error:
          "Invalid image. Please choose a normal JPG/PNG photo, not a PDF or an identity card"});}
        if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>MAX_BYTES)
          return res.status(415).json({error:"Photo was not safely processed"});
        let key=null;
        try{
          const shop=await pool.query("SELECT id FROM shops WHERE public_code=$1",[code]);
          if(!shop.rows.length)return res.status(404).json({error:"Shop not found"});
          const shopId=shop.rows[0].id;
          const count=await pool.query(
            "SELECT COUNT(*)::int AS total FROM test_file_orders WHERE shop_id=$1 AND file_deleted_at IS NULL AND created_at > NOW() - INTERVAL '24 hours'",
            [shopId]);
          if(Number(count.rows[0]?.total)>=10)return res.status(429).json({
            error:"This shop's private file storage is full; delete completed files first"});
          key="test-uploads/"+shopId+"/customer-photo-"+randomUUID()+".jpg";
          const hash=createHash("sha256").update(bytes).digest("hex");
          const trackingToken=randomBytes(24).toString("hex");
          const trackingHash=createHash("sha256").update(trackingToken).digest("hex");
          await storage.send(new PutObjectCommand({
            Bucket:cfg.bucket,Key:key,Body:bytes,
            ContentType:"image/jpeg",CacheControl:"private, no-store"
          }));
          const result=await pool.query(
            `INSERT INTO test_file_orders
              (shop_id,customer_id,storage_key,file_type,file_size_bytes,file_sha256,
               copies,print_mode,tracking_token_hash,document_kind)
             VALUES ($1,$2,$3,'jpeg',$4,$5,$6,$7,$8,'customer_photo')
             RETURNING id,status,created_at AS "createdAt"`,
            [shopId,req.session?.userId||null,key,bytes.length,hash,
              copies,printMode,trackingHash]);
          res.set("Cache-Control","private, no-store");
          return res.status(201).json({
            photoPilot:true,identityDocumentsAllowed:false,automaticPrinting:false,
            message:"Private sanitized customer photo received. Shop review and payment verification required.",
            order:result.rows[0],trackingToken
          });
        }catch(err){
          if(key){
            try{await storage.send(new DeleteObjectCommand({Bucket:cfg.bucket,Key:key}));}
            catch{console.error("Customer photo cleanup failed");}
          }
          console.error("Private customer photo order failed",err?.name||"error");
          return res.status(503).json({error:"Private photo order could not be completed"});
        }
      });
    });
}
module.exports={sanitizeCustomerPhoto,installCustomerPhotoUploads,MAX_PIXELS,MAX_BYTES};
