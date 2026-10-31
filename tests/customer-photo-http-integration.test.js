"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const sharp=require("sharp");
const crypto=require("node:crypto");
const {installCustomerPhotoUploads}=require("../customer-photo-uploads");

const config={
  ENABLE_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"private-documents",
  FILE_STORAGE_ACCESS_KEY_ID:"fake-integration-test",
  FILE_STORAGE_SECRET_ACCESS_KEY:"fake-integration-test-secret"
};
const code="a".repeat(32);
async function runServer(){
  const app=express(),queries=[],commands=[];
  const pool={async query(sql,args){
    queries.push({sql,args});
    if(sql.startsWith("SELECT id FROM shops"))return {rows:[{id:13}]};
    if(sql.includes("COUNT(*)::int"))return {rows:[{total:0}]};
    if(sql.includes("INSERT INTO test_file_orders"))return {rows:[{
      id:77,status:"test_only",createdAt:new Date().toISOString()
    }]};
    throw Error("Unexpected SQL in photo integration test");
  }};
  const storage={async send(command){commands.push(command);return {}}};
  installCustomerPhotoUploads(app,pool,config,{storage});
  const server=await new Promise(resolve=>{
    const handle=app.listen(0,"127.0.0.1",()=>resolve(handle));
  });
  return {root:"http://127.0.0.1:"+server.address().port,
    commands,queries,
    async close(){await new Promise(resolve=>server.close(resolve));}};
}
function photoForm(buffer,hasConsent=true){
  const form=new FormData();
  form.set("file",new Blob([buffer],{type:"image/png"}),"normal.png");
  form.set("copies","2");
  form.set("printMode","bw");
  if(hasConsent)form.set("confirmedNonSensitive","yes");
  return form;
}
test("actual multipart customer photo receives a private order; raw PNG is never stored",async()=>{
  const h=await runServer();
  try{
    const raw=await sharp({create:{width:500,height:380,channels:4,background:"#d4f5ea"}}).png().toBuffer();
    const response=await fetch(h.root+"/api/public/shops/"+code+"/customer-photo-orders",{
      method:"POST",body:photoForm(raw)});
    assert.equal(response.status,201);
    const result=await response.json();
    assert.equal(result.photoPilot,true);
    assert.equal(result.identityDocumentsAllowed,false);
    assert.match(result.trackingToken,/^[a-f0-9]{48}$/);
    assert.equal(h.commands.length,1);
    const object=h.commands[0].input;
    assert.match(object.Key,/^test-uploads\/13\/customer-photo-[a-f0-9-]+\.jpg$/);
    assert.equal(object.ContentType,"image/jpeg");
    assert.equal(object.CacheControl,"private, no-store");
    assert.equal((await sharp(object.Body).metadata()).format,"jpeg");
    assert.notDeepEqual(object.Body,raw);
    const sql=h.queries.find(x=>x.sql.includes("INSERT INTO test_file_orders"));
    assert.ok(sql);
    assert.match(sql.sql,/customer_photo/);
    assert.equal(sql.args[0],13);
    assert.equal(sql.args[4],crypto.createHash("sha256").update(object.Body).digest("hex"));
    assert.equal(sql.args[6],"bw");
    assert.equal(sql.args[7],crypto.createHash("sha256").update(result.trackingToken).digest("hex"));
  }finally{await h.close();}
});
test("customer must explicitly confirm no sensitive identity data; PDFs fail closed",async()=>{
  const h=await runServer();
  try{
    const raw=await sharp({create:{width:500,height:380,channels:4,background:"#ffffff"}}).png().toBuffer();
    const denied=await fetch(h.root+"/api/public/shops/"+code+"/customer-photo-orders",{
      method:"POST",body:photoForm(raw,false)});
    assert.equal(denied.status,400);
    const form=new FormData();
    form.set("file",new Blob(["%PDF-1.4 test %%EOF"],{type:"application/pdf"}),"private.pdf");
    form.set("copies","1");form.set("printMode","bw");form.set("confirmedNonSensitive","yes");
    const pdf=await fetch(h.root+"/api/public/shops/"+code+"/customer-photo-orders",{
      method:"POST",body:form});
    assert.equal(pdf.status,415);
    assert.equal(h.commands.length,0);
    assert.equal(h.queries.length,0);
  }finally{await h.close();}
});
