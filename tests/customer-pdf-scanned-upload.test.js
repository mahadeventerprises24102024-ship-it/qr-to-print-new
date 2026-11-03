"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createServer}=require("node:http");
const {validCustomerPdf,installCustomerPdfUploads}=require("../customer-pdf-uploads");
const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n","ascii");
const env={
  ENABLE_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://"+"a".repeat(32)+".r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"private-documents",
  FILE_STORAGE_ACCESS_KEY_ID:"fake-key",
  FILE_STORAGE_SECRET_ACCESS_KEY:"fake-secret"
};
const code="a".repeat(32);
test("PDF upload rejects encrypted, JavaScript and invalid payloads even before scanner",()=>{
 const file={buffer:pdf,originalname:"simple.pdf",mimetype:"application/pdf"};
 assert.equal(validCustomerPdf(file),true);
 assert.equal(validCustomerPdf({...file,mimetype:"image/png"}),false);
 assert.equal(validCustomerPdf({...file,buffer:Buffer.concat([pdf,Buffer.from("/Encrypt")])}),false);
 assert.equal(validCustomerPdf({...file,buffer:Buffer.concat([pdf,Buffer.from("/JavaScript")])}),false);
 assert.equal(validCustomerPdf({...file,originalname:"danger.exe"}),false);
});
async function withServer(allowed,fn){
 const app=express(),queries=[],objects=[];
 app.use(express.json());
 const pool={async query(sql,args){
   queries.push({sql,args});
   if(sql.startsWith("SELECT id FROM shops"))return {rows:[{id:12}]};
   if(sql.includes("COUNT(*)"))return {rows:[{total:0}]};
   if(sql.includes("INSERT INTO test_file_orders"))return {rows:[{id:93,status:"test_only"}]};
   throw Error("Unexpected SQL "+sql);
 }};
 const storage={async send(command){objects.push(command);return {}}};
 let scanCount=0;
 installCustomerPdfUploads(app,pool,
   {...env,...(allowed?{DOCUMENT_SCAN_SOCKET:"/run/clamav/clamd.sock"}:{})},
   {storage,scan:async bytes=>{scanCount++;return {clean:true}}});
 const server=createServer(app);
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{await fn({root:"http://127.0.0.1:"+server.address().port,queries,objects,scanCount:()=>scanCount});}
 finally{await new Promise(resolve=>server.close(resolve));}
}
function payload(){
 const fd=new FormData();
 fd.set("file",new Blob([pdf],{type:"application/pdf"}),"regular.pdf");
 fd.set("copies","2");fd.set("printMode","bw");
 fd.set("confirmedNonSensitive","yes");fd.set("paymentMethod","cash");
 return fd;
}
test("no configured PDF malware scanner means upload is off and nothing is stored",async()=>{
 await withServer(false,async h=>{
   const config=await (await fetch(h.root+"/api/customer-document/config")).json();
   assert.equal(config.pdfUploadEnabled,false);
   const response=await fetch(h.root+"/api/public/shops/"+code+"/customer-pdf-orders",
     {method:"POST",body:payload()});
   assert.equal(response.status,503);
   assert.equal(h.scanCount(),0);
   assert.equal(h.objects.length,0);
 });
});
test("scanner-cleared non-sensitive PDF is stored privately and is always manual-print",async()=>{
 await withServer(true,async h=>{
   const config=await (await fetch(h.root+"/api/customer-document/config")).json();
   assert.equal(config.pdfUploadEnabled,true);
   assert.equal(config.pdfAutoPrintEnabled,false);
   const response=await fetch(h.root+"/api/public/shops/"+code+"/customer-pdf-orders",
     {method:"POST",body:payload()});
   const data=await response.json();
   assert.equal(response.status,201,JSON.stringify(data));
   assert.equal(data.automaticPrinting,false);
   assert.match(data.trackingToken,/^[a-f0-9]{48}$/);
   assert.equal(h.scanCount(),1);
   assert.equal(h.objects.length,1);
   assert.match(h.queries.at(-1).sql,/customer_pdf/);
   assert.match(h.queries.at(-1).sql,/INSERT INTO test_file_orders/);
 });
});
test("PDF route never feeds the auto-print queue; public form hides old demo uploader",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const root=path.join(__dirname,"..");
 const page=fs.readFileSync(path.join(root,"print.html"),"utf8");
 const queue=fs.readFileSync(path.join(root,"auto-print-queue.js"),"utf8");
 assert.match(page,/id="legacy-test-upload" hidden/);
 assert.match(page,/id="demo-details" hidden/);
 assert.match(page,/accept="image\/jpeg,image\/png,application\/pdf/);
 assert.match(page,/customer-pdf-orders/);
 assert.match(queue,/o.document_kind='customer_photo'/);
 assert.doesNotMatch(queue,/o.document_kind='customer_pdf'/);
});
