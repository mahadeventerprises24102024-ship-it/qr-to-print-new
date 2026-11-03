"use strict";
// Create privacy-sanitized A4 2-up / 4-up customer photo sheets.
// These are JPEG customer_photo orders, eligible for the EXISTING Windows
// photo agent only AFTER shop-owner acceptance and verified UPI bank credit.
// PDFs and identity documents cannot enter this route.
const {randomUUID,randomBytes,createHash}=require("node:crypto");
const multer=require("multer");
const rateLimit=require("express-rate-limit");
const sharp=require("sharp");
const {S3Client,PutObjectCommand,DeleteObjectCommand}=require("@aws-sdk/client-s3");
const {storageSettings}=require("./private-test-uploads");
const {sanitizeCustomerPhoto}=require("./customer-photo-uploads");
const {createOnlinePhotoQuote}=require("./upi-print-payments");
const MAX_BYTES=2*1024*1024;
const WIDTH=1240, HEIGHT=1754, MARGIN=58, GAP=22;
const validShopCode=x=>/^[a-f0-9]{32}$/.test(x||"");
const validMode=x=>x==="bw"||x==="color";
async function assembleCustomerPhotoSheet(files,layout,opts={}){
  if(![2,4].includes(layout)||!Array.isArray(files)||files.length!==layout)
    throw new Error("Choose exactly 2 or 4 JPG/PNG photos");
  const sanitize=opts.sanitize||sanitizeCustomerPhoto;
  const boxes=[];
  const cols=layout===2?1:2,rows=layout===2?2:2;
  const boxW=Math.floor((WIDTH-2*MARGIN-(cols-1)*GAP)/cols);
  const boxH=Math.floor((HEIGHT-2*MARGIN-(rows-1)*GAP)/rows);
  for(let i=0;i<layout;i++){
    const clean=await sanitize(files[i]);
    if(!Buffer.isBuffer(clean)||clean.length<8||clean.length>MAX_BYTES||
       clean.subarray(0,3).toString("hex")!=="ffd8ff")
      throw new Error("Invalid sanitized image");
    const image=await sharp(clean,{limitInputPixels:8*1024*1024,pages:1})
      .resize(boxW,boxH,{fit:"contain",background:"#ffffff"})
      .flatten({background:"#ffffff"})
      .jpeg({quality:80})
      .toBuffer();
    boxes.push({
      input:image,
      top:MARGIN+Math.floor(i/cols)*(boxH+GAP),
      left:MARGIN+(i%cols)*(boxW+GAP)
    });
  }
  const base=sharp({create:{width:WIDTH,height:HEIGHT,channels:3,background:"#ffffff"}})
    .composite(boxes);
  let rendered=await base.clone().jpeg({quality:82}).toBuffer();
  if(rendered.length>MAX_BYTES)
    rendered=await base.clone().jpeg({quality:66}).toBuffer();
  if(rendered.length<8||rendered.length>MAX_BYTES)
    throw new Error("A4 print page could not fit safe storage limit");
  return rendered;
}
function installCustomerPhotoLayoutOrders(app,pool,env=process.env,deps={}){
  const cfg=storageSettings(env);
  const storage=cfg.enabled?(deps.storage||new S3Client({
    endpoint:cfg.endpoint,region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey}
  })):null;
  const upload=multer({storage:multer.memoryStorage(),limits:{
    fileSize:MAX_BYTES,files:4,fields:5,parts:9,fieldSize:64
  }});
  const limiter=rateLimit({windowMs:60*60*1000,limit:4,
    standardHeaders:"draft-7",legacyHeaders:false,
    message:{error:"Too many photo print requests. Try again later."}});
  app.post("/api/public/shops/:code/customer-photo-layout-orders",limiter,(req,res)=>{
    if(!storage)return res.status(503).json({error:"Private photo storage unavailable"});
    upload.array("photos",4)(req,res,async err=>{
      if(err)return res.status(err.code==="LIMIT_FILE_SIZE"?413:400).json({
        error:"Choose up to 4 JPG/PNG photos, each less than 2 MB"});
      const layout=Number(req.body?.layout);
      const copies=Number(req.body?.copies);
      const printMode=req.body?.printMode;
      if(!validShopCode(req.params.code)||![2,4].includes(layout)||
         !Number.isInteger(copies)||copies<1||copies>10||
         !validMode(printMode)||!["cash","online"].includes(req.body?.paymentMethod)||
         req.body?.confirmedNonSensitive!=="yes"||
         !Array.isArray(req.files)||req.files.length!==layout){
        return res.status(400).json({
          error:"Choose exactly 2 or 4 normal JPG/PNG photos, print options and consent"});
      }
      let bytes;
      try{
        bytes=await (deps.assemble||assembleCustomerPhotoSheet)(req.files,layout);
      }catch{
        return res.status(415).json({
          error:"Unable to create sanitized A4 photo sheet from these JPG/PNG files"});
      }
      if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>MAX_BYTES||
         bytes.subarray(0,3).toString("hex")!=="ffd8ff"){
        return res.status(415).json({error:"Safe photo sheet was not generated"});
      }
      let key=null;
      try{
        const shop=await pool.query("SELECT id FROM shops WHERE public_code=$1",
          [req.params.code]);
        if(!shop.rows.length)return res.status(404).json({error:"Shop not found"});
        const shopId=shop.rows[0].id;
        const count=await pool.query(
          "SELECT COUNT(*)::int AS total FROM test_file_orders WHERE shop_id=$1 AND file_deleted_at IS NULL AND created_at > NOW() - INTERVAL '24 hours'",
          [shopId]);
        if(Number(count.rows[0]?.total)>=10)return res.status(429).json({
          error:"This shop has reached its 24-hour upload limit"});
        key="test-uploads/"+shopId+"/customer-photo-layout-"+randomUUID()+".jpg";
        const hash=createHash("sha256").update(bytes).digest("hex");
        const trackingToken=randomBytes(24).toString("hex");
        const trackingHash=createHash("sha256").update(trackingToken).digest("hex");
        await storage.send(new PutObjectCommand({
          Bucket:cfg.bucket,Key:key,Body:bytes,
          ContentType:"image/jpeg",CacheControl:"private, no-store"
        }));
        const result=await pool.query(
          "INSERT INTO test_file_orders "+
          "(shop_id,customer_id,storage_key,file_type,file_size_bytes,file_sha256,"+
          "copies,print_mode,tracking_token_hash,document_kind,photo_layout,payment_method,print_service) "+
          "VALUES ($1,$2,$3,'jpeg',$4,$5,$6,$7,$8,'customer_photo',$9,$10,$11) "+
          'RETURNING id,status,created_at AS "createdAt"',
          [shopId,req.session?.userId||null,key,bytes.length,hash,
            copies,printMode,trackingHash,layout,req.body.paymentMethod,layout===4?"photo_4":"photo_2"]);
          let customerUpiQuote=null;
          if(req.body.paymentMethod==="online"){
            try{
              customerUpiQuote=await (deps.createUpiQuote||createOnlinePhotoQuote)(
                pool,shopId,result.rows[0].id);
            }catch(e){
              console.warn("UPI QR not available immediately for customer order",e?.name);
            }
          }
        res.set("Cache-Control","private, no-store");
        return res.status(201).json({
          photoPilot:true,order:result.rows[0],trackingToken,
          photoLayout:layout,paymentMethod:req.body.paymentMethod,automaticPrinting:false,upiQrPrepared:!!customerUpiQuote,
          message:"A4 photo print request created. Shop acceptance, verified UPI bank receipt, and enabled Windows Agent are required."
        });
      }catch(e){
        if(key)try{
          await storage.send(new DeleteObjectCommand({Bucket:cfg.bucket,Key:key}));
        }catch{console.error("Photo layout cleanup failed");}
        console.error("Photo sheet order failed",e?.name||"error");
        return res.status(503).json({error:"Photo print request could not be saved"});
      }
    });
  });
}
module.exports={assembleCustomerPhotoSheet,installCustomerPhotoLayoutOrders,WIDTH,HEIGHT};
