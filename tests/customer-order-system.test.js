"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
function getModule(file){
  const code=fs.readFileSync(path.join(__dirname,"..",file),"utf8");
  const limiter=()=>((req,res,next)=>next());
  const fakeMulter=()=>({single:()=>((req,res,callback)=>callback(null))});
  fakeMulter.memoryStorage=()=>({});
  class Command{constructor(input){this.input=input;}}
  const fakeRequire=name=>{
    if(name==="node:crypto")return crypto;
    if(name==="express-rate-limit")return limiter;
    if(name==="multer")return fakeMulter;
    if(name==="@aws-sdk/client-s3")return {
      S3Client:class{async send(){return {};}},
      PutObjectCommand:Command,GetObjectCommand:Command,DeleteObjectCommand:Command
    };
    throw new Error("Unexpected require "+name);
  };
  const mod={exports:{}};
  vm.runInNewContext(code,{
    module:mod,require:fakeRequire,Buffer,URL,process,console
  },{filename:file});
  return mod.exports;
}
function routes(){
  const map={};return {
    map,
    app:{
      get(path,...handlers){map["GET "+path]=handlers;},
      post(path,...handlers){map["POST "+path]=handlers;},
      delete(path,...handlers){map["DELETE "+path]=handlers;}
    }
  };
}
function response(){
  return {
    statusCode:200,body:null,headers:{},
    status(code){this.statusCode=code;return this;},
    json(value){this.body=value;return this;},
    set(name,value){this.headers[name]=value;return this;}
  };
}
const code="a".repeat(32);
const orderStatus="/api/public/shops/:code/demo-orders/status";

test("demo order migration adds non-enumerable tracking hashes and review/closed status",async()=>{
  const mod=getModule("demo-print-orders.js");
  const calls=[];
  await mod.ensureDemoOrderTables({query:async sql=>{calls.push(sql);return {rows:[]};}});
  assert.ok(calls.some(x=>x.includes("ADD COLUMN IF NOT EXISTS tracking_token_hash")));
  assert.ok(calls.some(x=>x.includes("tracking_hash_unique")));
  assert.ok(calls.some(x=>x.includes("'demo_only','reviewed','closed'")));
  const token=mod.makeTrackingToken();
  assert.match(token.token,/^[a-f0-9]{48}$/);
  assert.match(token.hash,/^[a-f0-9]{64}$/);
  assert.equal(mod.trackingHash(token.token),token.hash);
  assert.equal(mod.trackingHash("bad"),null);
});
test("customer test order metadata creates a unique tracking code but never uploads a file",async()=>{
  const mod=getModule("demo-print-orders.js");
  const qs=[];
  const pool={query:async(sql,params)=>{
    qs.push({sql,params});
    if(sql.includes("SELECT id FROM shops"))return {rows:[{id:41}]};
    if(sql.includes("COUNT(*)"))return {rows:[{total:0}]};
    if(sql.includes("INSERT INTO demo_print_requests"))return {rows:[{id:17,status:"demo_only"}]};
    throw Error("Unexpected query "+sql);
  }};
  const {app,map}=routes();mod.installDemoOrderApis(app,pool);
  const req={
    params:{code},body:{fileType:"pdf",fileSizeBytes:4300,copies:2}
  };
  const res=response();
  await map["POST /api/public/shops/:code/demo-orders"].at(-1)(req,res);
  assert.equal(res.statusCode,201);
  assert.equal(res.body.demoOnly,true);
  assert.equal(res.body.fileUploaded,false);
  assert.equal(res.body.order.id,17);
  assert.match(res.body.trackingToken,/^[a-f0-9]{48}$/);
  assert.equal(qs.at(-1).params[0],41);
  assert.equal(qs.at(-1).params[4],mod.trackingHash(res.body.trackingToken));
  assert.equal(JSON.stringify(res.body).includes("storage_key"),false);
});
test("demo tracking checks selected shop ID and hash; wrong code or token cannot read an order",async()=>{
  const mod=getModule("demo-print-orders.js");
  const token=mod.makeTrackingToken();
  let passed;
  const pool={query:async(sql,params)=>{
    passed={sql,params};
    return {rows:[{id:17,status:"reviewed"}]};
  }};
  const {app,map}=routes();mod.installDemoOrderApis(app,pool);
  const get=map["POST "+orderStatus].at(-1);
  const wrong=response();await get({params:{code},body:{orderId:17,trackingToken:"falsified"}},wrong);
  assert.equal(wrong.statusCode,400);
  const ok=response();await get({params:{code},body:{orderId:17,trackingToken:token.token}},ok);
  assert.equal(ok.body.order.status,"reviewed");
  assert.deepEqual(Array.from(passed.params),[code,"17",token.hash]);
  assert.match(passed.sql,/s\.public_code=\$1 AND r\.id=\$2 AND r\.tracking_token_hash=\$3/);
});
test("shop owner may review and close only their own demo orders",async()=>{
  const mod=getModule("demo-print-orders.js");
  let params,sql,rows=[{id:27,status:"reviewed"}];
  const {app,map}=routes();
  mod.installDemoOrderApis(app,{query:async(query,values)=>{sql=query;params=values;return {rows};}});
  const handlers=map["POST /api/shop/demo-orders/:id/status"];
  const unauth=response();await handlers.at(-1)({session:{},params:{id:"27"},body:{status:"reviewed"}},unauth);
  assert.equal(unauth.statusCode,401);
  const invalid=response();await handlers.at(-1)({
    session:{shopOwnerId:6},params:{id:"27"},body:{status:"printed"}
  },invalid);
  assert.equal(invalid.statusCode,400);
  const accepted=response();await handlers.at(-1)({
    session:{shopOwnerId:6},params:{id:"27"},body:{status:"reviewed"}
  },accepted);
  assert.equal(accepted.body.order.status,"reviewed");
  assert.deepEqual(Array.from(params),[6,"27","reviewed"]);
  assert.match(sql,/owner\.id=\$1 AND r\.id=\$2/);
  assert.match(sql,/r\.status='demo_only'/);
  rows=[];
  const repeat=response();await handlers.at(-1)({
    session:{shopOwnerId:6},params:{id:"27"},body:{status:"reviewed"}
  },repeat);
  assert.equal(repeat.statusCode,409);
});
test("private test decision is tenant-scoped; rejected file cannot be printed",async()=>{
  const mod=getModule("private-test-uploads.js");
  let sql,params;
  const {app,map}=routes();
  mod.installTestFileUploads(app,{query:async(q,args)=>{sql=q;params=args;return {rows:[{id:23,status:"accepted"}]};}}, {});
  const routePath="/api/shop/test-file-orders/:id/decision";
  const handler=map["POST "+routePath].at(-1);
  const denied=response();
  let bypassed=false;
  map["POST "+routePath][0]({session:{},params:{id:"23"},body:{decision:"accepted"}},
    denied,()=>{bypassed=true;});
  assert.equal(denied.statusCode,401);
  assert.equal(bypassed,false);
  const bad=response();
  await handler({session:{shopOwnerId:3},params:{id:"23"},body:{decision:"printed"}},bad);
  assert.equal(bad.statusCode,400);
  const allowed=response();
  await handler({session:{shopOwnerId:3},params:{id:"23"},body:{decision:"accepted"}},allowed);
  assert.equal(allowed.body.order.status,"accepted");
  assert.deepEqual(Array.from(params),[3,"23","accepted"]);
  assert.match(sql,/owner\.id = \$1 AND o\.id = \$2/);
  assert.match(sql,/o\.status = 'test_only'/);
  const code=fs.readFileSync(path.join(__dirname,"..","private-test-uploads.js"),"utf8");
  assert.match(code,/o\.status = 'accepted'/);
  assert.match(code,/status IN \('test_only','accepted','rejected','printed'\)/);
});
test("private sample status lookup requires secret and selected shop",async()=>{
  const mod=getModule("private-test-uploads.js");
  const token="a".repeat(48),hash=crypto.createHash("sha256").update(token).digest("hex");
  const {app,map}=routes();let sql,params;
  mod.installTestFileUploads(app,{query:async(q,args)=>{sql=q;params=args;return {rows:[{id:91,status:"accepted"}]};}},{});
  const run=map["POST /api/public/shops/:code/test-file-orders/status"].at(-1);
  const invalid=response();await run({params:{code},body:{orderId:91,trackingToken:"wrong"}},invalid);
  assert.equal(invalid.statusCode,400);
  const okay=response();await run({params:{code},body:{orderId:91,trackingToken:token}},okay);
  assert.equal(okay.body.order.status,"accepted");
  assert.match(sql,/s\.public_code = \$1 AND o\.id = \$2 AND o\.tracking_token_hash = \$3/);
  assert.deepEqual(Array.from(params),[code,"91",hash]);
});
test("customer page never asks for sensitive files or advertises automatic print",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","print.html"),"utf8");
  assert.match(html,/id="track-form"/);
  assert.match(html,/trackingToken/);
  assert.match(html,/demo-orders\/status|demo-orders/);
  assert.match(html,/Non-sensitive test file/);
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const shop=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");
  assert.match(shop,/Accept test order/);
  assert.match(shop,/Close demo request/);
  new vm.Script(shop.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const preview=fs.readFileSync(path.join(__dirname,"..","shop-print-preview.html"),"utf8");
  assert.match(preview,/id="accept-order"/);
  new vm.Script(preview.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
