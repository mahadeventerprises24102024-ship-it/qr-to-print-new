"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const crypto=require("node:crypto");

const source=fs.readFileSync(path.join(__dirname,"..","approved-test-print.js"),"utf8");
function makeModule(){
  const exports={};
  const mod={exports};
  class Command { constructor(params){this.params=params;} }
  class S3Client { async send(){throw Error("Do not call R2 in tests");} }
  vm.runInNewContext(source,{
    module:mod,Buffer,console,process,
    require(name){
      if(name==="node:crypto")return crypto;
      if(name==="express-rate-limit")return ()=> (req,res,next)=>next();
      if(name==="@aws-sdk/client-s3")return {S3Client,GetObjectCommand:Command};
      if(name==="./private-test-uploads")return {
        storageSettings:env=>({enabled:env.TEST_STORAGE==="true",
          endpoint:"https://example.r2.cloudflarestorage.com",bucket:"private",
          accessKeyId:"test",secretAccessKey:"test"}),
        detectSafeFile:()=>null,
        MAX_FILE_BYTES:2*1024*1024
      };
      throw Error("Unexpected dependency: "+name);
    }
  },{filename:"approved-test-print.js"});
  return mod.exports;
}
function response(){
  return {code:200,data:null,headers:{},
    status(n){this.code=n;return this;},
    set(k,v){if(typeof k==="string")this.headers[k]=v;else Object.assign(this.headers,k);return this;},
    json(d){this.data=d;return this;}};
}
function routes(mod, pool, env){
  const out={};
  const app={
    get(p,...handlers){out["GET "+p]=handlers;},
    post(p,...handlers){out["POST "+p]=handlers;}
  };
  mod.installApprovedTestPrintApis(app,pool,env);
  return out;
}

test("test printing stays OFF without independent R2 and owner opt-ins",()=>{
  const mod=makeModule();
  assert.equal(mod.enabled({}),false);
  assert.equal(mod.enabled({ENABLE_OWNER_APPROVED_TEST_PRINTS:"true"}),false);
  assert.equal(mod.enabled({ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"}),true);
  assert.equal(mod.enabled({ENABLE_OWNER_APPROVED_TEST_PRINTS:"false",TEST_STORAGE:"true"}),false);
});

test("no job can be claimed when disabled or agent lacks capability",async()=>{
  const mod=makeModule();
  const db={async query(){throw Error("Disabled job must not access DB");}};
  assert.equal(await mod.processAgentApprovedHeartbeat(db,7,true,null,{}),null);
  assert.equal(await mod.processAgentApprovedHeartbeat(db,7,false,null,
    {ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"}),null);
});

test("owner must be authenticated to request or list approved test prints",()=>{
  const mod=makeModule();
  const a=routes(mod,{query(){throw Error("No anonymous DB access");}},{});
  for(const key of ["GET /api/shop/approved-test-print/status",
    "POST /api/shop/approved-test-print/:orderId"]){
    const res=response();
    a[key][0]({session:{}},res,()=>{throw Error("Auth bypass");});
    assert.equal(res.code,401);
  }
});

test("print request remains denied by default, even with shop owner login",async()=>{
  const mod=makeModule();
  const a=routes(mod,{},{});const res=response();
  await a["POST /api/shop/approved-test-print/:orderId"][2](
    {session:{shopOwnerId:1},params:{orderId:"1"},body:{reviewed:true}},res);
  assert.equal(res.code,503);
});

test("server claims a fixed, bounded test print and acknowledges by shop",async()=>{
  const mod=makeModule();const calls=[];
  const pool={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes("RETURNING j.id"))return {rows:[{id:31,
      fileType:"pdf",fileBytes:100,sha256:"f".repeat(64),copies:2,printMode:"bw"}]};
    return {rows:[]};
  }};
  const env={ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"};
  const job=await mod.processAgentApprovedHeartbeat(pool,7,true,null,env);
  assert.equal(job.id,"31");
  assert.equal(job.kind,"approved_private_test_file");
  assert.equal(job.fileBytes,100);
  assert.equal(job.pdfMaxPages,2);
  assert.ok(calls.some(x=>x.sql.includes("FOR UPDATE SKIP LOCKED")));
  assert.ok(calls.some(x=>x.sql.includes("status='queued'")));

  calls.length=0;
  await mod.processAgentApprovedHeartbeat(pool,7,true,{id:"31",status:"submitted"},env);
  const ack=calls.find(x=>x.sql.includes("status=$3"));
  assert.ok(ack.sql.includes("shop_id=$2 AND status='claimed'"));
  assert.deepEqual(Array.from(ack.args),["31",7,"submitted"]);
});

test("unsafe acknowledgments rejected before changing any queue state",async()=>{
  const mod=makeModule();
  const pool={async query(){return {rows:[]};}};
  const env={ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"};
  await assert.rejects(mod.processAgentApprovedHeartbeat(pool,7,true,
    {id:"99;delete",status:"submitted"},env),/Invalid approved print acknowledgment/);
  await assert.rejects(mod.processAgentApprovedHeartbeat(pool,7,true,
    {id:"1",status:"printed"},env),/Invalid approved print acknowledgment/);
});

test("invalid agent token, browser Origin or job ID cannot retrieve test file",async()=>{
  const mod=makeModule();
  const env={ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"};
  const pool={async query(){throw Error("Unauthenticated requests cannot query DB");}};
  const a=routes(mod,pool,env);const handler=a["GET /api/agent/approved-test-print/:jobId/file"][0];
  for(const req of [
    {params:{jobId:"1"},get(){return undefined;}},
    {params:{jobId:"1"},get(n){return n==="origin"?"https://evil.test":"Bearer qrpa_"+"a".repeat(43);}},
    {params:{jobId:"1 OR 1=1"},get(n){return n==="authorization"?"Bearer qrpa_"+"a".repeat(43):undefined;}}
  ]){
    const res=response();await handler(req,res);assert.equal(res.code,401);
  }
});

test("one-use owner approval requires explicit reviewed=true and 1-2 copies",async()=>{
  const mod=makeModule();
  const env={ENABLE_OWNER_APPROVED_TEST_PRINTS:"true",TEST_STORAGE:"true"};
  const db={async query(sql){
    if(sql.startsWith("SELECT f.id"))return {rows:[{id:50,shop_id:9,file_type:"pdf",copies:3}]};
    throw Error("No inserts should occur");
  }};
  const a=routes(mod,db,env);
  const approve=a["POST /api/shop/approved-test-print/:orderId"][2];
  let res=response();
  await approve({session:{shopOwnerId:8},params:{orderId:"50"},body:{}},res);
  assert.equal(res.code,400);
  res=response();
  await approve({session:{shopOwnerId:8},params:{orderId:"50"},body:{reviewed:true}},res);
  assert.equal(res.code,400);
});
