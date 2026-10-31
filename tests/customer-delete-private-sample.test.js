"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"..","private-test-uploads.js"),"utf8");
const ui=fs.readFileSync(path.join(__dirname,"..","print.html"),"utf8");
const upi=fs.readFileSync(path.join(__dirname,"..","upi-print-payments.js"),"utf8");
const env={
  ENABLE_TEST_UPLOADS:"true",ENABLE_GUEST_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"qr-to-print-test-private",
  FILE_STORAGE_ACCESS_KEY_ID:"fake-test-access",FILE_STORAGE_SECRET_ACCESS_KEY:"fake-test-secret"
};
const code="a".repeat(32),token="b".repeat(48);
const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
function harness(rows=[{id:11,storage_key:"test-uploads/2/sample.pdf",fileDeletedAt:null}]){
  const routes={},queries=[],storageCommands=[];
  const fakeMulter=()=>({single:()=>((req,res,next)=>next())});
  fakeMulter.memoryStorage=()=>({});
  class DeleteObjectCommand{constructor(input){this.input=input;}}
  class Command{constructor(input){this.input=input;}}
  const fakeRequire=name=>{
    if(name==="node:crypto")return crypto;
    if(name==="multer")return fakeMulter;
    if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
    if(name==="@aws-sdk/client-s3")return {
      S3Client:class{async send(cmd){storageCommands.push(cmd);return {};}},
      PutObjectCommand:Command,GetObjectCommand:Command,DeleteObjectCommand
    };
    throw Error("Unexpected dependency "+name);
  };
  const module={exports:{}};
  vm.runInNewContext(source,{module,require:fakeRequire,Buffer,URL,process,console});
  const app={
    get(route,...handlers){routes["GET "+route]=handlers;},
    post(route,...handlers){routes["POST "+route]=handlers;},
    delete(route,...handlers){routes["DELETE "+route]=handlers;}
  };
  const pool={async query(sql,args){
    queries.push({sql,args});
    if(sql.includes("SELECT o.id, o.storage_key"))return {rows};
    if(sql.includes("UPDATE test_file_orders o SET file_deleted_at"))return {rows:[{id:11}]};
    return {rows:[],rowCount:0};
  }};
  module.exports.installTestFileUploads(app,pool,env);
  return {routes,queries,storageCommands};
}
function response(){
  return {
    statusCode:200,body:null,headers:{},
    status(code){this.statusCode=code;return this;},
    json(value){this.body=value;return this;},
    set(name,value){this.headers[name]=value;return this;}
  };
}
function request(body={orderId:"11",trackingToken:token}){
  return {params:{code},body};
}
const route="POST /api/public/shops/:code/test-file-orders/delete";
test("customer deletion requires a scoped shop QR, order ID and secret tracking token",async()=>{
  const h=harness(),handler=h.routes[route].at(-1);
  for(const input of [
    request({orderId:"11",trackingToken:"invalid"}),
    {params:{code:"bad"},body:{orderId:"11",trackingToken:token}},
    request({orderId:"-3",trackingToken:token})
  ]){
    const res=response();await handler(input,res);
    assert.equal(res.statusCode,400);
  }
  assert.equal(h.queries.length,0);
  const missing=harness([]),res=response();
  await missing.routes[route].at(-1)(request(),res);
  assert.equal(res.statusCode,404);
  assert.equal(missing.storageCommands.length,0);
});
test("valid private token deletes only the R2 object and retains billing/payment audit",async()=>{
  const h=harness(),res=response();
  await h.routes[route].at(-1)(request(),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.deleted,true);
  assert.equal(res.body.retainedAuditOnly,true);
  assert.equal(res.body.testOnly,true);
  assert.equal(res.headers["Cache-Control"],"private, no-store");
  assert.equal(h.storageCommands.length,1);
  assert.equal(h.storageCommands[0].input.Key,"test-uploads/2/sample.pdf");
  assert.equal(h.storageCommands[0].input.Bucket,env.FILE_STORAGE_BUCKET);
  assert.equal(h.queries.length,2);
  assert.match(h.queries[0].sql,/s\.public_code = \$1 AND o\.id = \$2/);
  assert.match(h.queries[0].sql,/o\.tracking_token_hash = \$3/);
  assert.match(h.queries[1].sql,/file_deleted_at = NOW\(\)/);
  assert.match(h.queries[1].sql,/s\.public_code = \$1/);
  assert.match(h.queries[1].sql,/o\.tracking_token_hash = \$3/);
  assert.deepEqual(Array.from(h.queries[0].args),[code,"11",tokenHash]);
  assert.deepEqual(Array.from(h.queries[1].args),[code,"11",tokenHash]);
  assert.doesNotMatch(source,/DELETE FROM test_file_orders/);
  assert.equal(JSON.stringify(res.body).includes("storage_key"),false);
});
test("already-deleted files are idempotent and are not touched again",async()=>{
  const h=harness([{id:11,storage_key:"test-uploads/2/sample.pdf",fileDeletedAt:new Date()}]);
  const res=response();
  await h.routes[route].at(-1)(request(),res);
  assert.equal(res.body.deleted,true);
  assert.equal(res.body.alreadyDeleted,true);
  assert.equal(h.storageCommands.length,0);
  assert.equal(h.queries.length,1);
});
test("free-plan sample quota counts active objects only, not expired/deleted audit rows",()=>{
  assert.match(source,/COUNT\(\*\)::int AS total FROM test_file_orders WHERE shop_id = \$1 AND file_deleted_at IS NULL AND created_at > NOW\(\) - INTERVAL '24 hours'/);
});
test("customer UI shows personal deletion after private tracking, no sensitive documents enabled",()=>{
  assert.match(ui,/id="delete-my-sample"/);
  assert.match(ui,/id="customer-delete-tools"/);
  assert.match(ui,/test-file-orders\/delete/);
  assert.match(ui,/trackingToken/);
  assert.match(ui,/data\.order\.fileDeleted/);
  const script=ui.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script[1]));
  assert.match(source,/file_deleted_at IS NOT NULL\) AS "fileDeleted"/);
});
test("deleted file cannot be newly quoted or released for UPI printing",()=>{
  assert.match(upi,/AND o\.file_deleted_at IS NULL/);
  assert.match(upi,/AND p\.status='paid_manual'/);
  assert.match(source,/o\.file_deleted_at IS NULL/);
});
