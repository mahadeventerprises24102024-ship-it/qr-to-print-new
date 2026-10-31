"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const crypto=require("node:crypto");
const source=fs.readFileSync(path.join(__dirname,"..","auto-print-queue.js"),"utf8");
const dashboard=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
const agent=require("../windows-auto-print-agent");
const TOKEN="qrpa_"+"A".repeat(43);
const LEASE="a".repeat(64);
function createHarness(rows={}){
  const routes={},queries=[],commands=[];
  class Cmd{constructor(input){this.input=input;}}
  const mod={exports:{}};
  vm.runInNewContext(source,{
    module:mod,console,Buffer,process,
    require(name){
      if(name==="node:crypto")return crypto;
      if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
      if(name==="sharp")return ()=>{throw Error("No grayscale in this test")};
      if(name==="./private-test-uploads")return {storageSettings:()=>({
        enabled:true,bucket:"photos-private",endpoint:"https://example.invalid",
        accessKeyId:"fake",secretAccessKey:"fake"
      })};
      if(name==="@aws-sdk/client-s3")return {
        S3Client:class {async send(cmd){commands.push(cmd);return {}}},
        GetObjectCommand:Cmd
      };
      throw Error("Unexpected "+name);
    }
  },{filename:"auto-print-queue.js"});
  const app={
    get(p,...h){routes["GET "+p]=h},
    post(p,...h){routes["POST "+p]=h},
    put(p,...h){routes["PUT "+p]=h}
  };
  const pool={async query(sql,args){
    queries.push({sql,args});
    if(sql.includes('RETURNING j.id,j.order_id AS "orderId"'))return {rows:rows.claim||[]};
    if(sql.includes('SELECT o.storage_key AS "key"'))return {rows:rows.file||[]};
    if(sql.includes('RETURNING j.id,j.status'))return {rows:rows.ack||[]};
    if(sql.includes('RETURNING a.auto_print_enabled'))return {rows:rows.setting||[]};
    return {rows:[]};
  }};
  const storage={async send(cmd){commands.push(cmd);return rows.storage||{
    ContentLength:0,Body:{transformToByteArray:async()=>[]}
  }}};
  mod.exports.installAutoPrint(app,pool,{ENABLE_TEST_UPLOADS:"true"},storage);
  return {routes,queries,commands,db:mod.exports};
}
function response(){
  return {code:200,data:null,headers:{},payload:null,
    set(k,v){if(typeof k==="object")Object.assign(this.headers,k);
      else this.headers[k]=v;return this;},
    status(v){this.code=v;return this;},
    json(v){this.data=v;return this;},
    type(x){this.headers["Content-Type"]=x;return this;},
    send(x){this.payload=x;return this;}
  };
}
function req(extra={}){
  return {params:{id:"19"},session:{shopOwnerId:4},
    body:{},get(name){
      return (name==="authorization"?"Bearer "+TOKEN:
        name==="x-print-lease"?LEASE:null);
    },...extra};
}
test("migrations create disabled by default and unique order-backed queue",async()=>{
  const h=createHarness();
  const sql=[];
  await h.db.ensureAutoPrintTables({query:async x=>{sql.push(x);return {rows:[]}}});
  assert.match(sql.join("\n"),/auto_print_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql.join("\n"),/order_id BIGINT NOT NULL UNIQUE/);
  assert.match(sql.join("\n"),/claim_expires_at TIMESTAMPTZ/);
  assert.match(sql.join("\n"),/needs_review/);
});
test("only shop owner can opt in, and a detected printer is required",async()=>{
  const h=createHarness();
  const gate=h.routes["PUT /api/shop/auto-print/settings"][0];
  const denied=response();gate({session:{}},denied,()=>assert.fail("Auth bypass"));
  assert.equal(denied.code,401);
  const good=response();
  await h.routes["PUT /api/shop/auto-print/settings"].at(-1)(
    req({body:{enabled:true}}),good);
  assert.equal(good.code,409);
  assert.match(h.queries[0].sql,/a.printer_names \? a.preferred_printer_name/);
  assert.match(h.queries[0].sql,/auto_print_enabled_at/);
});
test("bearer token and no browser origin required before agent can claim work",async()=>{
  const h=createHarness(),route=h.routes["POST /api/agent/auto-print/claim"].at(-1);
  const blocked=response();
  await route(req({get:()=>null}),blocked);
  assert.equal(blocked.code,401);
  assert.equal(h.queries.length,0);
  const origin=response();
  await route(req({get:n=>n==="origin"?"https://evil.invalid":"Bearer "+TOKEN}),origin);
  assert.equal(origin.code,401);
  assert.equal(h.queries.length,0);
});
test("claim selects only sanitized JPG with owner bank verification and prevents replay",async()=>{
  const h=createHarness({claim:[{
    id:19,orderId:31,printerName:"HP LaserJet",copies:2,printMode:"bw"
  }]});
  const out=response();
  await h.routes["POST /api/agent/auto-print/claim"].at(-1)(req(),out);
  assert.equal(out.code,200);
  assert.equal(out.data.job.id,19);
  assert.match(out.data.job.leaseToken,/^[a-f0-9]{64}$/);
  assert.equal(out.data.job.paperSize,"A4");
  assert.equal(out.data.job.kind,"sanitized_customer_photo_jpeg");
  assert.equal(h.queries.length,3);
  assert.match(h.queries[0].sql,/status='needs_review'/);
  assert.match(h.queries[1].sql,/p.status='paid_manual'/);
  assert.match(h.queries[1].sql,/p.confirmed_by_owner_id IS NOT NULL/);
  assert.match(h.queries[1].sql,/p.confirmed_at>=a.auto_print_enabled_at/);
  assert.match(h.queries[1].sql,/o.document_kind='customer_photo'/);
  assert.match(h.queries[1].sql,/o.file_type='jpeg'/);
  assert.match(h.queries[1].sql,/o.file_deleted_at IS NULL/);
  assert.match(h.queries[1].sql,/ON CONFLICT\(order_id\) DO NOTHING/);
  assert.match(h.queries[2].sql,/FOR UPDATE OF j SKIP LOCKED LIMIT 1/);
  assert.match(h.queries[2].sql,/j.status='queued'/);
  assert.match(h.queries[2].sql,/o.document_kind='customer_photo'/);
  assert.match(h.queries[2].sql,/a.token_hash=\$1/);
});
test("agent file download is scoped to claim + paid photo, with SHA-256 validation",async()=>{
  const bytes=Buffer.from([255,216,255,5,5,5,255,217]);
  const h=createHarness({file:[{
    key:"test-uploads/11/customer-photo-id.jpg",
    hash:crypto.createHash("sha256").update(bytes).digest("hex"),
    size:bytes.length,printMode:"color"
  }],storage:{
    ContentLength:bytes.length,
    Body:{transformToByteArray:async()=>[...bytes]}
  }});
  const out=response();
  await h.routes["GET /api/agent/auto-print/file/:id"].at(-1)(req(),out);
  assert.equal(out.code,200);
  assert.deepEqual(out.payload,bytes);
  assert.equal(out.headers["Cache-Control"],"private, no-store");
  assert.match(h.queries[0].sql,/j.claim_hash=\$3/);
  assert.match(h.queries[0].sql,/j.claim_expires_at>NOW\(\)/);
  assert.match(h.queries[0].sql,/o.document_kind='customer_photo'/);
  assert.match(h.queries[0].sql,/p.status='paid_manual'/);
  assert.match(h.queries[0].sql,/o.file_deleted_at IS NULL/);
  const bad=response();
  await h.routes["GET /api/agent/auto-print/file/:id"].at(-1)(
    req({get:n=>n==="authorization"?"Bearer "+TOKEN:"no"}),bad);
  assert.equal(bad.code,401);
});
test("agent ACK never confirms physical paper; no automatic retry of uncertain job",async()=>{
  const h=createHarness({ack:[{id:19,status:"spooled"}]});
  const resp=response();
  await h.routes["POST /api/agent/auto-print/ack/:id"].at(-1)(
    req({body:{leaseToken:LEASE,result:"spooled"}}),resp);
  assert.equal(resp.code,200);
  assert.equal(resp.data.physicalPaperConfirmed,false);
  assert.match(h.queries[0].sql,/j.claim_hash=\$3/);
  assert.match(h.queries[0].sql,/j.status='claimed'/);
  assert.match(h.queries[0].sql,/claim_expires_at>NOW\(\)/);
  const invalid=response();
  await h.routes["POST /api/agent/auto-print/ack/:id"].at(-1)(
    req({body:{leaseToken:"x",result:"spooled"}}),invalid);
  assert.equal(invalid.code,400);
});
test("local printer worker uses fixed commands, not arbitrary PDF commands, and validates installed printer",()=>{
  const valid={id:19,kind:"sanitized_customer_photo_jpeg",leaseToken:LEASE,
    printerName:"HP LaserJet",paperSize:"A4",copies:2,printMode:"bw"};
  assert.ok(agent.validateJob(valid,["HP LaserJet"]));
  assert.equal(agent.validateJob({...valid,printerName:"Unknown"},["HP LaserJet"]),false);
  assert.equal(agent.validateJob({...valid,kind:"pdf"},["HP LaserJet"]),false);
  assert.equal(agent.validateJob({...valid,copies:100},["HP LaserJet"]),false);
  assert.match(agent.PRINT_SCRIPT,/System\.Drawing\.Printing\.PrintDocument/);
  assert.match(agent.PRINT_SCRIPT,/Get-Printer/);
  assert.match(agent.PRINT_SCRIPT,/StandardPrintController/);
  assert.match(agent.PRINT_SCRIPT,/IsValid/);
  assert.doesNotMatch(agent.PRINT_SCRIPT,/Invoke-Expression|Start-Process|cmd\.exe|Get-Content/);
});
test("dashboard and server keep local auto print explicitly opt-in",()=>{
  assert.match(dashboard,/id="auto-print-enabled"/);
  assert.match(dashboard,/Install-QR-To-Print-Auto-Print\.cmd/);
  assert.match(dashboard,/id="auto-print-jobs"/);
  assert.match(dashboard,/ownerAutoPrintEnabled/);
  assert.match(server,/installAutoPrint\(app,pool\)/);
  assert.match(server,/await ensureAutoPrintTables\(pool\)/);
  assert.match(server,/\/agent\/auto-print\/claim/);
  const htmlScript=dashboard.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(htmlScript);assert.doesNotThrow(()=>new vm.Script(htmlScript[1]));
});
