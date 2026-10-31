"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const sharp=require("sharp");
const {sanitizeCustomerPhoto,installCustomerPhotoUploads,MAX_PIXELS}=require("../customer-photo-uploads");

test("normal JPEG photo is flattened and metadata-free, within strict pixel and file limits",async()=>{
  const file={originalname:"normal-photo.jpg",mimetype:"image/jpeg",
    buffer:await sharp({create:{width:640,height:480,channels:3,background:"#88bbdd"}})
      .jpeg().toBuffer()};
  const bytes=await sanitizeCustomerPhoto(file);
  assert.ok(bytes.length>8 && bytes.length<=2097152);
  assert.equal(bytes.subarray(0,3).toString("hex"),"ffd8ff");
  const result=await sharp(bytes).metadata();
  assert.equal(result.format,"jpeg");
  assert.equal(result.exif,undefined);
  assert.equal(result.xmp,undefined);
  assert.equal(result.width,640);
  assert.equal(result.height,480);
});
test("normal PNG can be safely converted to stripped JPEG",async()=>{
  const file={originalname:"scan.png",mimetype:"image/png",
    buffer:await sharp({create:{width:900,height:550,channels:4,background:"#ffffff"}})
      .png().toBuffer()};
  const bytes=await sanitizeCustomerPhoto(file);
  assert.equal((await sharp(bytes).metadata()).format,"jpeg");
});
test("PDF, forged MIME and extremely small or large photos are blocked",async()=>{
  await assert.rejects(sanitizeCustomerPhoto({originalname:"fake.pdf",mimetype:"application/pdf",
    buffer:Buffer.from("%PDF-1.4\n%%EOF")}),/Only valid JPEG\/PNG/);
  const image=await sharp({create:{width:120,height:120,channels:3,background:"red"}}).png().toBuffer();
  await assert.rejects(sanitizeCustomerPhoto({originalname:"small.png",mimetype:"image/png",buffer:image}),
    /dimensions/);
  await assert.rejects(sanitizeCustomerPhoto({originalname:"fake.jpg",mimetype:"image/jpeg",buffer:image}),
    /Only valid JPEG\/PNG/);
  const huge=await sharp({create:{width:3500,height:3500,channels:3,background:"#ffffff"}}).jpeg().toBuffer();
  assert.ok(3500*3500>MAX_PIXELS);
  await assert.rejects(sanitizeCustomerPhoto({originalname:"huge.jpg",mimetype:"image/jpeg",buffer:huge}),
    /Input image exceeds pixel limit|dimensions/);
});
test("photo pilot route uses private R2, consent, shop-scoped token and no raw PDF support",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","customer-photo-uploads.js"),"utf8");
  const page=fs.readFileSync(path.join(__dirname,"..","print.html"),"utf8");
  const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  const migration=fs.readFileSync(path.join(__dirname,"..","private-test-uploads.js"),"utf8");
  assert.match(source,/body\.confirmedNonSensitive!=="yes"/);
  assert.match(source,/identityDocumentsAllowed:false/);
  assert.match(source,/test-uploads\/"/);
  assert.match(source,/ContentType:"image\/jpeg"/);
  assert.match(source,/tracking_token_hash,document_kind/);
  assert.match(source,/customer_photo/);
  assert.match(source,/sharp\.concurrency\(1\)/);
  assert.match(source,/sharp\.cache\(false\)/);
  assert.match(migration,/document_kind IN \('regular_test','dummy_card_front_back','customer_photo'\)/);
  assert.match(server,/installCustomerPhotoUploads\(app,pool\)/);
  assert.match(page,/id="customer-photo-form"/);
  assert.match(page,/confirmedNonSensitive/);
  assert.match(page,/customer-photo-orders/);
  assert.match(page,/asli|असली/);
  assert.doesNotThrow(()=>new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]));
});
