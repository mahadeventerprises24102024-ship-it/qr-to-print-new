"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const sharp=require("sharp");
const {createServer}=require("node:http");
const {assembleCustomerPhotoSheet,installCustomerPhotoLayoutOrders,WIDTH,HEIGHT}
  =require("../customer-photo-layouts");
const cfg={
  ENABLE_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://"+"a".repeat(32)+".r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"photo-uploads",
  FILE_STORAGE_ACCESS_KEY_ID:"fake-layout-key",
  FILE_STORAGE_SECRET_ACCESS_KEY:"fake-layout-secret"
};
const code="a".repeat(32);
async function mkPng(r=180,g=85,b=65){
  return sharp({create:{width:480,height:640,channels:3,background:{r,g,b,alpha:1}}})
    .png().toBuffer();
}
test("2-up and 4-up photo sheets are safe A4-shaped JPEG within 2 MB",async()=>{
  const image=await mkPng();
  for(const n of [2,4]){
    const files=Array.from({length:n},(_,i)=>({
      originalname:"photo"+i+".png",mimetype:"image/png",buffer:image
    }));
    const bytes=await assembleCustomerPhotoSheet(files,n);
    assert.ok(bytes.length<=2*1024*1024);
    assert.equal(bytes.subarray(0,3).toString("hex"),"ffd8ff");
    const meta=await sharp(bytes).metadata();
    assert.equal(meta.width,WIDTH);
    assert.equal(meta.height,HEIGHT);
    assert.equal(meta.format,"jpeg");
    assert.equal(meta.exif,undefined);
  }
});
test("reject wrong photo count, pdf and other unsupported uploaded file types",async()=>{
  const image=await mkPng();
  const good={originalname:"photo.png",mimetype:"image/png",buffer:image};
  await assert.rejects(assembleCustomerPhotoSheet([good],2),/exactly 2 or 4/);
  await assert.rejects(assembleCustomerPhotoSheet([good,good,good],3),/exactly 2 or 4/);
  await assert.rejects(assembleCustomerPhotoSheet([good,{originalname:"x.pdf",
    mimetype:"application/pdf",buffer:Buffer.from("%PDF-1.7\n%%EOF") }],2),
    /Only valid JPEG\/PNG photo/);
});
async function withServer(fn){
  const app=express();
  const calls=[],objects=[];
  const pool={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes("SELECT id FROM shops"))return {rows:[{id:17}]};
    if(sql.includes("SELECT COUNT(*)"))return {rows:[{total:0}]};
    if(sql.includes("INSERT INTO test_file_orders"))return {rows:[{id:55,status:"test_only"}]};
    throw Error("Unexpected database query "+sql);
  }};
  const storage={async send(cmd){objects.push(cmd);return {}}};
  installCustomerPhotoLayoutOrders(app,pool,cfg,{storage});
  const server=createServer(app);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{await fn({url:"http://127.0.0.1:"+server.address().port,
    calls,objects});}
  finally{await new Promise(resolve=>server.close(resolve));}
}
async function form(n,options={}){
  const fd=new FormData(),image=await mkPng();
  for(let i=0;i<(options.photos??n);i++){
    fd.append("photos",new Blob([image],{type:"image/png"}),"image"+i+".png");
  }
  fd.set("layout",String(n));
  fd.set("copies","3");
  fd.set("printMode","bw");
  if(!options.noConsent)fd.set("confirmedNonSensitive","yes");
  return fd;
}
test("actual customer POST composes 4 photos into one order, never prints before bank verification",async()=>{
  await withServer(async h=>{
    const r=await fetch(h.url+"/api/public/shops/"+code+"/customer-photo-layout-orders",{
      method:"POST",body:await form(4)
    });
    const d=await r.json();
    assert.equal(r.status,201,JSON.stringify(d));
    assert.equal(d.photoLayout,4);
    assert.equal(d.order.status,"test_only");
    assert.equal(d.automaticPrinting,false);
    assert.match(d.trackingToken,/^[a-f0-9]{48}$/);
    assert.equal(h.objects.length,1);
    assert.match(h.objects[0].input.Key,/^test-uploads\/17\/customer-photo-layout-/);
    assert.equal(h.objects[0].input.ContentType,"image/jpeg");
    assert.equal(h.calls.at(-1).args.at(-1),4);
    assert.match(h.calls.at(-1).sql,/customer_photo/);
    assert.match(h.calls.at(-1).sql,/photo_layout/);
  });
});
test("customer cannot bypass count or consent to trigger photo printing",async()=>{
  await withServer(async h=>{
    const r=await fetch(h.url+"/api/public/shops/"+code+"/customer-photo-layout-orders",{
      method:"POST",body:await form(4,{photos:3})
    });
    assert.equal(r.status,400);
    const noConsent=await fetch(h.url+"/api/public/shops/"+code+"/customer-photo-layout-orders",{
      method:"POST",body:await form(2,{noConsent:true})
    });
    assert.equal(noConsent.status,400);
    assert.equal(h.objects.length,0);
  });
});
test("legacy schema gets an A4 photo layout field without allowing PDFs into automatic queue",()=>{
  const fs=require("node:fs"),path=require("node:path");
  const root=path.join(__dirname,"..");
  const sql=fs.readFileSync(path.join(root,"private-test-uploads.js"),"utf8");
  const queue=fs.readFileSync(path.join(root,"auto-print-queue.js"),"utf8");
  assert.match(sql,/photo_layout SMALLINT NOT NULL DEFAULT 1 CHECK \(photo_layout IN \(1,2,4\)\)/);
  assert.match(sql,/o\.photo_layout AS "photoLayout"/);
  assert.match(queue,/o\.document_kind='customer_photo'/);
  assert.doesNotMatch(queue,/o\.document_kind='customer_pdf'/);
  assert.match(queue,/p\.confirmed_at>=a\.auto_print_enabled_at/);
});
