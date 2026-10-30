"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const nodeCrypto=require("node:crypto");

function apiHarness() {
  const code=fs.readFileSync(path.join(__dirname,"..","printer-agent-api.js"),"utf8");
  const moduleObject={exports:{}};
  vm.runInNewContext(code,{
    module:moduleObject,
    require(name){
      if(name==="node:crypto")return nodeCrypto;
      if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
      if(name==="./canon-test-print-api")return {
        canonTestPrintEnabled:()=>false,
        handleCanonTestHeartbeat:async()=>null
      };
      throw Error("Unknown dependency "+name);
    },console,Buffer
  },{filename:"printer-agent-api.js"});
  const routes={};
  const app={
    get(p,...h){routes["GET "+p]=h;},
    post(p,...h){routes["POST "+p]=h;},
    put(p,...h){routes["PUT "+p]=h;}
  };
  const reply=()=>({
    statusCode:200,body:null,headers:{},
    status(n){this.statusCode=n;return this;},
    json(data){this.body=data;return this;},
    set(name,value){this.headers[name]=value;return this;}
  });
  return {mod:moduleObject.exports,app,routes,reply};
}

test("agent printer list validates bounded names and prevents injected controls",()=>{
  const {mod}=apiHarness();
  assert.equal(mod.validPrinterNames(["HP LaserJet","EPSON EcoTank","Canon G2010"],3),true);
  assert.equal(mod.validPrinterNames([],0),true);
  assert.equal(mod.validPrinterNames(["HP"],0),false);
  assert.equal(mod.validPrinterNames(["HP","HP"],2),false);
  assert.equal(mod.validPrinterNames([" HP"],1),false);
  assert.equal(mod.validPrinterNames(["bad\nprinter"],1),false);
  assert.equal(mod.validPrinterNames(Array.from({length:31},(_,i)=>"Printer "+i),31),false);
  assert.equal(mod.validPrinterNames(["x".repeat(101)],1),false);
  assert.equal(mod.validPrinterNames("Canon G2010",1),false);
});

test("agent migration adds JSON printer names and owner preference without removing old table",async()=>{
  const {mod}=apiHarness();
  const sql=[];
  await mod.ensureAgentTables({query:async statement=>{sql.push(statement);return {rows:[]};}});
  assert.ok(sql.some(s=>s.includes("CREATE TABLE IF NOT EXISTS shop_print_agents")));
  assert.ok(sql.some(s=>s.includes("ADD COLUMN IF NOT EXISTS printer_names")));
  assert.ok(sql.some(s=>s.includes("ADD COLUMN IF NOT EXISTS preferred_printer_name")));
});

test("authenticated agent reports only bounded printer names and supports older count-only agents",async()=>{
  const {mod,app,routes,reply}=apiHarness();
  let query;
  mod.installAgentApis(app,{
    query:async(sql,params)=>{query={sql,params};return {rows:[{shop_id:21}]};}
  });
  const handler=routes["POST /api/agent/heartbeat"].at(-1);
  const token="qrpa_"+"x".repeat(43);
  const req=body=>({
    body,
    get(name){return name==="origin"?undefined:name==="authorization"?"Bearer "+token:undefined;}
  });
  const ok=reply();
  await handler(req({printerCount:2,printerNames:["HP LaserJet","Epson L3250"]}),ok);
  assert.equal(ok.statusCode,200);
  assert.equal(ok.body.printingEnabled,false);
  assert.equal(query.params[1],2);
  assert.equal(query.params[2],JSON.stringify(["HP LaserJet","Epson L3250"]));
  assert.match(query.sql,/printer_names = COALESCE\(\$3::jsonb, printer_names\)/);
  const older=reply();
  await handler(req({printerCount:3}),older);
  assert.equal(older.statusCode,200);
  assert.equal(query.params[2],null);
  const invalid=reply();
  await handler(req({printerCount:1,printerNames:["bad\nname"]}),invalid);
  assert.equal(invalid.statusCode,400);
});

test("preferred printer is shop scoped and must exist in online agent's reported list",async()=>{
  const {mod,app,routes,reply}=apiHarness();
  let query;
  let dbRows=[{preferredPrinterName:"HP LaserJet"}];
  mod.installAgentApis(app,{
    query:async(sql,params)=>{query={sql,params};return {rows:dbRows};}
  });
  const pair=routes["PUT /api/shop/agent/preferred-printer"];
  const unauthorized=reply();
  let next=false;
  pair[0]({session:{},body:{printerName:"HP LaserJet"}},unauthorized,()=>{next=true;});
  assert.equal(unauthorized.statusCode,401);
  assert.equal(next,false);
  const handler=pair.at(-1);
  const invalid=reply();
  await handler({session:{shopOwnerId:7},body:{printerName:"Fake\nPrinter"}},invalid);
  assert.equal(invalid.statusCode,400);
  const saved=reply();
  await handler({session:{shopOwnerId:7},body:{printerName:"HP LaserJet"}},saved);
  assert.equal(saved.body.preferredPrinterName,"HP LaserJet");
  assert.deepEqual(Array.from(query.params),[7,"HP LaserJet"]);
  assert.match(query.sql,/o\.id = \$1/);
  assert.match(query.sql,/a\.printer_names \? \$2::text/);
  assert.match(query.sql,/last_seen_at > NOW\(\) - INTERVAL '100 seconds'/);
  dbRows=[];
  const missing=reply();
  await handler({session:{shopOwnerId:7},body:{printerName:"Other printer"}},missing);
  assert.equal(missing.statusCode,409);
  const clear=reply();
  await handler({session:{shopOwnerId:7},body:{printerName:null}},clear);
  assert.equal(clear.statusCode,409);
  assert.equal(query.params[1],null);
});

test("agent status exposes only owning shop's detected names, never pairing key",async()=>{
  const {mod,app,routes,reply}=apiHarness();
  let query;
  mod.installAgentApis(app,{query:async(sql,params)=>{
    query={sql,params};
    return {rows:[{
      deviceLabel:"Windows Shop PC",
      printerCount:2,online:true,printerNames:["Canon G2010","HP LaserJet"],
      preferredPrinterName:"HP LaserJet",
      lastSeenAt:"2026-10-30T06:00:00Z"
    }]};
  }});
  const r=reply();
  await routes["GET /api/shop/agent/status"].at(-1)({session:{shopOwnerId:22}},r);
  assert.equal(r.body.preferredPrinterName,"HP LaserJet");
  assert.equal(r.body.printerNames.length,2);
  assert.equal(query.params[0],22);
  assert.match(query.sql,/JOIN shop_owners o ON o\.shop_id = a\.shop_id/);
  assert.ok(!JSON.stringify(r.body).includes("token_hash"));
  assert.equal(r.body.printingEnabled,false);
});

test("shop-local printer page requires owner and only invokes window.print on click",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","shop-printer-check.html"),"utf8");
  const js=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(js);
  new vm.Script(js[1]);
  assert.match(js[1],/addEventListener\("click"/);
  assert.match(js[1],/window\.confirm/);
  assert.match(js[1],/window\.print\(\)/);
  assert.doesNotMatch(html,/Canon G2010-only remote diagnostic/);
  const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  assert.match(server,/app\.get\("\/shop-printer-check\.html", shopPageGate\(pool\)/);
  const dashboard=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");
  assert.match(dashboard,/id="agent-printer-choice"/);
  assert.match(dashboard,/id="save-agent-printer"/);
  assert.match(dashboard,/shop-printer-check\.html/);
  new vm.Script(dashboard.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const preview=fs.readFileSync(path.join(__dirname,"..","shop-print-preview.html"),"utf8");
  assert.match(preview,/own installed shop printer/);
  assert.match(preview,/api\/shop\/agent\/status/);
  new vm.Script(preview.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test("Windows agent only discovers names; it never fetches customer documents",()=>{
  const code=fs.readFileSync(path.join(__dirname,"..","windows-print-agent.js"),"utf8");
  assert.match(code,/function listWindowsPrinters\(\)/);
  assert.match(code,/Get-Printer -ErrorAction Stop/);
  assert.match(code,/printerNames/);
  assert.match(code,/printingEnabled !== false/);
  assert.doesNotMatch(code,/api\/shop\/test-file-orders\/.*download/);
  new vm.Script(code);
});
