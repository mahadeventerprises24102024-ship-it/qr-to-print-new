"use strict";
// Direct customer PDF uploads (no legacy TEST UI). Fail closed unless a local,
// updated ClamAV scanner is configured and returns a clean verdict.
// PDFs are manual-review only and are never delivered to Windows Auto Print.
const {randomBytes,randomUUID,createHash}=require("node:crypto");
const multer=require("multer");
const rateLimit=require("express-rate-limit");
const {S3Client,PutObjectCommand,DeleteObjectCommand}=require("@aws-sdk/client-s3");
const {storageSettings}=require("./private-test-uploads");
const {scanDocumentWithClamd}=require("./document-malware-scan");

const MAX_PDF_BYTES=2*1024*1024;
function pdfScanSocket(env=process.env){
  const p=env.DOCUMENT_SCAN_SOCKET;
  return typeof p==="string"&&p.startsWith("/")&&p.length<=220&&!p.includes("\0")?p:null;
}
function validCustomerPdf(file){
  if(!file||file.mimetype!=="application/pdf"||
     !/\.pdf$/i.test(file.originalname||"")||
     !Buffer.isBuffer(file.buffer)||file.buffer.length<32||
     file.buffer.length>MAX_PDF_BYTES)return false;
  const b=file.buffer;
  if(b.subarray(0,5).toString("ascii")!=="%PDF-"||
     !b.subarray(b.length-1024).includes(Buffer.from("%%EOF")))return false;
  // Reject common active, encrypted or embedded-content features even when
  // scanner is configured. Byte matching is an extra guard, not PDF CDR.
  const raw=b.toString("latin1");
  return !/\/(?:Encrypt|JavaScript|JS|Launch|EmbeddedFile|AcroForm|XFA|OpenAction|RichMedia|SubmitForm)\b/i.test(raw);
}
function installCustomerPdfUploads(app,pool,env=process.env,deps={}){
  const cfg=storageSettings(env),socket=pdfScanSocket(env);
  const storage=cfg.enabled?(deps.storage||new S3Client({
    endpoint:cfg.endpoint,region:"auto",forcePathStyle:true,
    requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey}
  })):null;
  const scanner=deps.scan||scanDocumentWithClamd;
  const upload=multer({storage:multer.memoryStorage(),limits:{
    fileSize:MAX_PDF_BYTES,files:1,fields:4,parts:5,fieldSize:64
  }});
  const limiter=rateLimit({windowMs:60*60*1000,limit:4,
    standardHeaders:"draft-7",legacyHeaders:false,
    message:{error:"Too many uploads. Please try again later."}});
  app.get("/api/customer-document/config",(_req,res)=>{
    res.set("Cache-Control","no-store");
    res.json({pdfUploadEnabled:!!storage&&!!socket,
      pdfRequiresCleanScanner:true,manualPdfPrintingOnly:true,
      pdfAutoPrintEnabled:false,maxFileBytes:MAX_PDF_BYTES});
  });
  app.post("/api/public/shops/:code/customer-pdf-orders",limiter,(req,res)=>{
    if(!storage||!socket)return res.status(503).json({
      error:"PDF upload requires an active malware scanner and is not enabled on this server yet. JPG/PNG photo upload is available."});
    upload.single("file")(req,res,async(err)=>{
      if(err)return res.status(err.code==="LIMIT_FILE_SIZE"?413:400).json({
        error:"Select a PDF file up to 2 MB"});
      const code=req.params.code,body=req.body||{},copies=Number(body.copies);
      if(!/^[a-f0-9]{32}$/.test(code||"")||
         !Number.isInteger(copies)||copies<1||copies>10||
         !["bw","color"].includes(body.printMode)||
         body.confirmedNonSensitive!=="yes"||
         !validCustomerPdf(req.file))return res.status(400).json({
           error:"Choose a valid non-sensitive, non-encrypted PDF (up to 2 MB) and printing options"});
      try{
        const verdict=await scanner(req.file.buffer,{socketPath:socket});
        if(!verdict?.clean)return res.status(422).json({
          error:"PDF security scan did not approve this document"});
      }catch{
        return res.status(422).json({
          error:"PDF was not approved by the security scanner. Do not retry with sensitive documents."});
      }
      let key=null;
      try{
        const shop=await pool.query("SELECT id FROM shops WHERE public_code=$1",[code]);
        if(!shop.rows.length)return res.status(404).json({error:"Shop not found"});
        const shopId=shop.rows[0].id;
        const count=await pool.query(
          "SELECT COUNT(*)::int AS total FROM test_file_orders WHERE shop_id=$1 AND file_deleted_at IS NULL AND created_at>NOW()-INTERVAL '24 hours'",[shopId]);
        if(Number(count.rows[0]?.total)>=10)return res.status(429).json({
          error:"This shop has reached its 24-hour secure upload limit"});
        key="test-uploads/"+shopId+"/customer-pdf-"+randomUUID()+".pdf";
        const bytes=req.file.buffer,hash=createHash("sha256").update(bytes).digest("hex");
        const trackingToken=randomBytes(24).toString("hex");
        const tokenHash=createHash("sha256").update(trackingToken).digest("hex");
        await storage.send(new PutObjectCommand({
          Bucket:cfg.bucket,Key:key,Body:bytes,ContentType:"application/pdf",
          CacheControl:"private, no-store"
        }));
        const result=await pool.query(
          "INSERT INTO test_file_orders "+
          "(shop_id,customer_id,storage_key,file_type,file_size_bytes,file_sha256,"+
          "copies,print_mode,tracking_token_hash,document_kind) "+
          "VALUES ($1,$2,$3,'pdf',$4,$5,$6,$7,$8,'customer_pdf') "+
          'RETURNING id,status,created_at AS "createdAt"',
          [shopId,req.session?.userId||null,key,bytes.length,hash,
            copies,body.printMode,tokenHash]);
        res.set("Cache-Control","private, no-store");
        return res.status(201).json({order:result.rows[0],trackingToken,
          identityDocumentsAllowed:false,automaticallyVerified:false,
          automaticPrinting:false,
          message:"Customer PDF received. Only shopkeeper-reviewed, bank-verified manual printing is allowed."});
      }catch(e){
        if(key)try{await storage.send(new DeleteObjectCommand({Bucket:cfg.bucket,Key:key}));}
        catch{console.error("Customer PDF cleanup failed");}
        console.error("Customer PDF upload failed",e?.name||"error");
        return res.status(503).json({error:"PDF upload could not be saved"});
      }
    });
  });
}
module.exports={MAX_PDF_BYTES,pdfScanSocket,validCustomerPdf,installCustomerPdfUploads};
