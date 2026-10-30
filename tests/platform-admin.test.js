"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const bcrypt=require("bcryptjs");
const {
  PLAN_PRICES,planQuote,adminConfig,credentialVersion,subscriptionActive,ensurePlatformTables,
  shopApiGate,shopPageGate,publicShopGate,installPlatformAdmin
}=require("../platform-admin");

function response(){
  return {
    statusCode:200,headers:{},body:null,redirectUrl:null,
    status(code){this.statusCode=code;return this;},
    json(payload){this.body=payload;return this;},
    set(k,v){this.headers[k]=v;return this;},
    redirect(url){this.redirectUrl=url;return this;},
    send(text){this.body=text;return this;}
  };
}
function makeApp(pool,env){
  const routes={};
  const app={
    get(path,...fns){routes["GET "+path]=fns;},
    post(path,...fns){routes["POST "+path]=fns;}
  };
  installPlatformAdmin(app,pool,env);
  return routes;
}
const auth={PLATFORM_ADMIN_EMAIL:"admin@example.com",PLATFORM_ADMIN_PASSWORD_HASH:bcrypt.hashSync("test-secret-super-admin",4)};
function sessionReq(body={},id="3"){
  return {
    session:{platformAdminEmail:"admin@example.com",platformAdminCredentialVersion:credentialVersion(auth.PLATFORM_ADMIN_PASSWORD_HASH)},
    params:{id},body
  };
}
test("admin must be explicitly configured with a bcrypt hash, never plaintext",()=>{
  assert.equal(adminConfig({}).configured,false);
  assert.equal(adminConfig({PLATFORM_ADMIN_EMAIL:"admin@example.com",PLATFORM_ADMIN_PASSWORD_HASH:"mypassword"}).configured,false);
  assert.equal(adminConfig(auth).configured,true);
  assert.equal(adminConfig(auth).email,"admin@example.com");
  assert.equal(adminConfig({...auth,PLATFORM_ADMIN_EMAIL:"admin@example.com\ninjected"}).configured,false);
});
test("pending, suspended, expired denied; legacy active shops grandfathered",()=>{
  const future=new Date("2099-01-01T00:00:00Z"),past=new Date("2020-01-01T00:00:00Z");
  assert.equal(subscriptionActive({subscription_status:"active",subscription_expires_at:null}),true);
  assert.equal(subscriptionActive({subscription_status:"pending",subscription_expires_at:null}),false);
  assert.equal(subscriptionActive({subscription_status:"suspended",subscription_expires_at:future}),false);
  assert.equal(subscriptionActive({subscription_status:"active",subscription_expires_at:future}),true);
  assert.equal(subscriptionActive({subscription_status:"active",subscription_expires_at:past}),false);
  assert.equal(subscriptionActive({subscription_status:"active",subscription_expires_at:"bad"}),false);
});
test("migration is backward compatible and records subscription audit",async()=>{
  const statements=[];
  await ensurePlatformTables({query:async sql=>{statements.push(sql);return {rows:[]};}});
  assert.equal(statements.length,10);
  assert.match(statements[0],/DEFAULT 'active'/);
  assert.match(statements[1],/DEFAULT 'legacy'/);
  assert.match(statements[4],/CREATE TABLE IF NOT EXISTS shop_subscription_events/);
  assert.match(statements[4],/received_paise/);
  assert.match(statements[6],/platform_page_usage_events/);
  assert.match(statements[8],/platform_demo_page_events/);
});
test("shop-owner API sessions require active plan on every request",async()=>{
  let state={subscription_status:"active",subscription_expires_at:null};
  let queryParams;
  const gate=shopApiGate({query:async(sql,params)=>{
    queryParams=params;
    assert.match(sql,/o.id=\$1/);
    return {rows:[state]};
  }});
  let calls=0;
  const ok=response();
  await gate({path:"/pricing",session:{shopOwnerId:81}},ok,()=>{calls++;});
  assert.equal(calls,1);
  assert.deepEqual(queryParams,[81]);
  state={subscription_status:"suspended",subscription_expires_at:null};
  const denied=response();
  await gate({path:"/pricing",session:{shopOwnerId:81}},denied,()=>{calls++;});
  assert.equal(denied.statusCode,403);
  assert.equal(denied.body.code,"SHOP_SUBSCRIPTION_INACTIVE");
  assert.equal(calls,1);
  await gate({path:"/logout",session:{shopOwnerId:81}},response(),()=>{calls++;});
  assert.equal(calls,2);
});
test("shop dashboard blocks suspended owners even with old sessions",async()=>{
  const gate=shopPageGate({query:async()=>({
    rows:[{subscription_status:"pending",subscription_expires_at:null}]
  })});
  const r=response();
  await gate({session:{shopOwnerId:2}},r,()=>{throw Error("not allowed");});
  assert.equal(r.redirectUrl,"/shop-login.html?inactive=1");
  const anonymous=response();
  await gate({session:{}},anonymous,()=>{throw Error("not allowed");});
  assert.equal(anonymous.redirectUrl,"/shop-login.html");
});
test("public QR for pending shop cannot access uploads, demo orders or prices",async()=>{
  let rows=[{subscription_status:"pending",subscription_expires_at:null}];
  const gate=publicShopGate({query:async(sql,params)=>{
    assert.match(sql,/WHERE s\.public_code=\$1/);
    assert.deepEqual(params,["a".repeat(32)]);
    return {rows};
  }});
  let called=false;
  const r=response();
  await gate({params:{code:"a".repeat(32)}},r,()=>{called=true;});
  assert.equal(r.statusCode,403);
  assert.equal(called,false);
  rows=[{subscription_status:"active",subscription_expires_at:null}];
  await gate({params:{code:"a".repeat(32)}},response(),()=>{called=true;});
  assert.equal(called,true);
  rows=[{subscription_status:"active",subscription_expires_at:null,plan_code:"demo",demoPagesUsed:10}];
  called=false;
  const exhausted=response();
  await gate({params:{code:"a".repeat(32)}},exhausted,()=>{called=true;});
  assert.equal(exhausted.statusCode,403);
  assert.equal(exhausted.body.code,"DEMO_QUOTA_EXHAUSTED");
  assert.equal(called,false);
  const invalid=response();
  await gate({params:{code:"invalid"}},invalid,()=>{});
  assert.equal(invalid.statusCode,400);
});
test("admin login fails closed when Render credentials not set",async()=>{
  const routes=makeApp({query:async()=>({rows:[]})},{});
  const r=response();
  await routes["POST /api/platform/login"][1]({body:{email:"admin@example.com",password:"password"}},r);
  assert.equal(r.statusCode,503);
  assert.equal(r.body.error.includes("setup incomplete"),true);
});
test("admin and shop/customer roles are different; admin listing is protected",async()=>{
  const routes=makeApp({query:async()=>{throw Error("Should not query");}},auth);
  const middleware=routes["GET /api/platform/shops"][0];
  const blocked=response();
  middleware({session:{shopOwnerId:3,userId:5}},blocked,()=>{throw Error("Unauthorized");});
  assert.equal(blocked.statusCode,401);
  const passed=response();
  let called=false;
  middleware(sessionReq(),passed,()=>{called=true;});
  assert.equal(called,true);
  const oldSession=response();let oldCalled=false;
  middleware({session:{platformAdminEmail:"admin@example.com",platformAdminCredentialVersion:"old-hash"}},oldSession,()=>{oldCalled=true;});
  assert.equal(oldSession.statusCode,401);
  assert.equal(oldCalled,false);
});
test("correct admin login rotates session and saves only the admin role",async()=>{
  const routes=makeApp({query:async()=>({rows:[]})},auth);
  const handler=routes["POST /api/platform/login"][1];
  const wrong=response();
  await handler({body:{email:"admin@example.com",password:"wrong password"}},wrong);
  assert.equal(wrong.statusCode,401);
  const req={
    body:{email:"admin@example.com",password:"test-secret-super-admin"},
    session:{
      shopOwnerId:40,
      regenerate(fn){delete this.shopOwnerId;fn(null);},
      save(fn){fn(null);}
    }
  };
  const right=response();
  await handler(req,right);
  assert.equal(right.body.message,"Platform admin logged in");
  assert.equal(req.session.platformAdminEmail,"admin@example.com");
  assert.equal(req.session.platformAdminCredentialVersion,credentialVersion(auth.PLATFORM_ADMIN_PASSWORD_HASH));
  assert.equal(req.session.shopOwnerId,undefined);
});
test("admin activation validates plan, fixed duration and manual payment confirmation",async()=>{
  const routes=makeApp({connect:async()=>{throw Error("Must not call DB");}},auth);
  const handler=routes["POST /api/platform/shops/:id/activate"][1];
  for(const body of [
    {planCode:"invalid",durationDays:30,amountReceivedRupees:0,paymentMethod:"none"},
    {planCode:"starter",durationDays:31,amountReceivedRupees:0,paymentMethod:"none"},
    {planCode:"starter",durationDays:30,amountReceivedRupees:299,paymentMethod:"upi"},
    {planCode:"starter",durationDays:30,amountReceivedRupees:0,paymentMethod:"upi"},
    {planCode:"starter",durationDays:30,amountReceivedRupees:-1,paymentMethod:"none"}
  ]){
    const r=response();await handler(sessionReq(body),r);
    assert.equal(r.statusCode,400);
  }
});
test("admin can activate approved shop in one auditable transaction",async()=>{
  const logs=[];
  const client={
    async query(sql,params){
      logs.push({sql,params});
      if(sql.includes("UPDATE shops"))return {rows:[{id:3,name:"Demo Shop",planCode:"starter",status:"active"}]};
      return {rows:[]};
    },
    release(){logs.push({sql:"released"});}
  };
  const routes=makeApp({connect:async()=>client},auth);
  const r=response();
  await routes["POST /api/platform/shops/:id/activate"][1](sessionReq({
    planCode:"starter",durationDays:30,amountReceivedRupees:299,
    paymentMethod:"cash",confirmedReceipt:true
  }),r);
  assert.equal(r.body.shop.status,"active");
  assert.deepEqual(logs.map(x=>x.sql.slice(0,6)),["BEGIN","UPDATE","INSERT","COMMIT","releas"]);
  assert.deepEqual(logs[1].params,["3","starter",30]);
  assert.deepEqual(logs[2].params,["3","starter",30,29900,"cash","admin@example.com"]);
});
test("admin suspension requires confirmation and creates audit event",async()=>{
  const logs=[];
  const client={
    async query(sql,params){
      logs.push({sql,params});
      if(sql.includes("UPDATE shops"))return {rows:[{id:3,name:"Demo Shop",planCode:"pro",status:"suspended"}]};
      return {rows:[]};
    },
    release(){}
  };
  const routes=makeApp({connect:async()=>client},auth);
  const handler=routes["POST /api/platform/shops/:id/suspend"][1];
  const r=response();
  await handler(sessionReq({confirmedSuspension:false}),r);
  assert.equal(r.statusCode,400);
  const confirmed=response();
  await handler(sessionReq({confirmedSuspension:true}),confirmed);
  assert.equal(confirmed.body.shop.status,"suspended");
  assert.match(logs[2].sql,/shop_subscription_events/);
  assert.deepEqual(logs[2].params,["3","pro","admin@example.com"]);
});
test("admin HTML pages and shop login script parse; registration must be pending",()=>{
  const dir=path.resolve(__dirname,"..");
  const server=fs.readFileSync(path.join(dir,"server.js"),"utf8");
  const shopAuth=fs.readFileSync(path.join(dir,"shop-auth.js"),"utf8");
  for(const filename of ["admin-login.html","admin-dashboard.html","shop-login.html"]){
    const html=fs.readFileSync(path.join(dir,filename),"utf8");
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length>0,filename);
    scripts.forEach(m=>new vm.Script(m[1]));
  }
  assert.match(server,/installPlatformAdmin\(app, pool\)/);
  assert.match(server,/app\.use\("\/api\/shop", shopApiGate\(pool\)\)/);
  assert.match(server,/app\.use\("\/api\/public\/shops\/:code", publicShopGate\(pool\)\)/);
  assert.match(server,/await ensurePlatformTables\(pool\)/);
  assert.match(server,/app\.get\("\/admin-dashboard\.html"[\s\S]*?platformAdminEmail/);
  assert.match(shopAuth,/INSERT INTO shops\(name, public_code, subscription_status, plan_code\)/);
  assert.match(shopAuth,/'pending'/);
  assert.match(shopAuth,/account\.subscription_status !== "active"/);
});


test("plan catalog prices monthly Starter 49, Pro 99, Business 199, per page 15p and Demo 10 prints",async()=>{
  assert.equal(PLAN_PRICES.starter.monthlyPaise,4900);
  assert.equal(PLAN_PRICES.pro.monthlyPaise,9900);
  assert.equal(PLAN_PRICES.business.monthlyPaise,19900);
  assert.equal(PLAN_PRICES.per_page.perPagePaise,15);
  assert.equal(PLAN_PRICES.demo.freePages,10);
  assert.equal(planQuote("starter",30).upfrontPaise,4900);
  assert.equal(planQuote("pro",90).upfrontPaise,29700);
  assert.equal(planQuote("business",365).upfrontPaise,238800);
  assert.equal(planQuote("per_page",30,100).usagePaise,1500);
  assert.equal(planQuote("demo",30).includedDemoPages,10);
  assert.equal(planQuote("demo",30).upfrontPaise,0);
  assert.throws(()=>planQuote("demo",31));
  const routes=makeApp({query:async()=>({rows:[]})},auth);
  const denied=response();
  routes["GET /api/platform/plans"][0]({session:{}},denied,()=>{throw Error("must not be anonymous");});
  assert.equal(denied.statusCode,401);
  let nextCalled=false;
  routes["GET /api/platform/plans"][0](sessionReq(),response(),()=>{nextCalled=true;});
  assert.equal(nextCalled,true);
  const plans=response();
  routes["GET /api/platform/plans"][1](sessionReq(),plans);
  assert.equal(plans.body.plans.length,5);
  assert.equal(plans.body.plans.find(p=>p.code==="demo").freePages,10);
});

test("Demo activation requires exactly 30 days and zero actual payment",async()=>{
  const routes=makeApp({connect:async()=>{throw Error("invalid activation must not query");}},auth);
  const handler=routes["POST /api/platform/shops/:id/activate"][1];
  for(const body of [
    {planCode:"demo",durationDays:90,amountReceivedRupees:0,paymentMethod:"none"},
    {planCode:"demo",durationDays:30,amountReceivedRupees:10,paymentMethod:"cash",confirmedReceipt:true}
  ]){
    const r=response();
    await handler(sessionReq(body),r);
    assert.equal(r.statusCode,400);
  }
});

test("one-time Demo activation checks prior grants under transaction lock",async()=>{
  let alreadyUsed=false;
  const statements=[];
  const client={
    async query(sql,params){
      statements.push({sql,params});
      if(sql.includes("SELECT id FROM shops WHERE id=$1 FOR UPDATE"))return {rows:[{id:3}]};
      if(sql.includes("FROM shop_subscription_events WHERE shop_id"))return {rows:alreadyUsed?[{id:7}]:[]};
      if(sql.includes("UPDATE shops"))return {rows:[{id:3,name:"Demo Shop",status:"active",planCode:"demo"}]};
      return {rows:[]};
    },
    release(){}
  };
  const routes=makeApp({connect:async()=>client},auth);
  const handler=routes["POST /api/platform/shops/:id/activate"][1];
  const approved=response();
  await handler(sessionReq({planCode:"demo",durationDays:30,amountReceivedRupees:0,paymentMethod:"none"}),approved);
  assert.equal(approved.statusCode,200);
  assert.equal(approved.body.shop.planCode,"demo");
  assert.ok(statements.some(x=>x.sql.includes("FOR UPDATE")));
  assert.ok(statements.some(x=>x.sql.includes("shop_subscription_events")));
  alreadyUsed=true;
  statements.length=0;
  const repeated=response();
  await handler(sessionReq({planCode:"demo",durationDays:30,amountReceivedRupees:0,paymentMethod:"none"}),repeated);
  assert.equal(repeated.statusCode,409);
  assert.ok(statements.some(x=>x.sql==="ROLLBACK"));
  assert.ok(!statements.some(x=>x.sql.includes("UPDATE shops")));
});

test("Demo usage atomically enforces 10 confirmed free pages and shop plan",async()=>{
  let used=7,active=true,inserted=0,releaseCount=0;
  const queries=[];
  const client={
    async query(sql,params){
      queries.push({sql,params});
      if(sql.includes("SELECT id FROM shops WHERE id=$1 AND plan_code='demo'")){
        assert.match(sql,/FOR UPDATE/);
        return {rows:active?[{id:3}]:[]};
      }
      if(sql.includes('SELECT COALESCE(SUM(pages),0)::int AS "pagesUsed"')){
        return {rows:[{pagesUsed:used}]};
      }
      if(sql.includes("INSERT INTO platform_demo_page_events")){
        inserted++;
        used+=params[1];
        return {rows:[{id:inserted,shopId:3,pages:params[1]}]};
      }
      return {rows:[]};
    },release(){releaseCount++;}
  };
  const routes=makeApp({connect:async()=>client},auth);
  const middleware=routes["POST /api/platform/shops/:id/demo-usage"][0];
  const unauthorized=response();
  middleware({session:{shopOwnerId:3}},unauthorized,()=>{throw Error("shop owner must not record platform pages");});
  assert.equal(unauthorized.statusCode,401);
  const handler=routes["POST /api/platform/shops/:id/demo-usage"][1];
  const bad=response();
  await handler(sessionReq({pages:3,confirmedPrintedPages:false}),bad);
  assert.equal(bad.statusCode,400);
  const moreThanRemaining=response();
  await handler(sessionReq({pages:4,confirmedPrintedPages:true}),moreThanRemaining);
  assert.equal(moreThanRemaining.statusCode,409);
  assert.ok(queries.some(x=>x.sql==="ROLLBACK"));
  assert.equal(inserted,0);
  const justEnough=response();
  await handler(sessionReq({pages:3,confirmedPrintedPages:true}),justEnough);
  assert.equal(justEnough.statusCode,201);
  assert.equal(justEnough.body.pagesUsed,10);
  assert.equal(justEnough.body.pagesRemaining,0);
  assert.equal(inserted,1);
  const fullyUsed=response();
  await handler(sessionReq({pages:1,confirmedPrintedPages:true}),fullyUsed);
  assert.equal(fullyUsed.statusCode,409);
  active=false;
  const inactive=response();
  await handler(sessionReq({pages:1,confirmedPrintedPages:true}),inactive);
  assert.equal(inactive.statusCode,409);
  assert.equal(releaseCount,4);
});

test("shop plan usage is scoped to the signed-in shop owner",async()=>{
  const params=[];
  const routes=makeApp({query:async(sql,p)=>{
    assert.match(sql,/o\.id=\$1/);
    params.push(p);
    return {rows:[{planCode:"demo",expiresAt:"2026-11-29",demoPagesUsed:7,perPageRecordedPages:0}]};
  }},auth);
  const handler=routes["GET /api/shop/plan-usage"][0];
  const denied=response();
  await handler({session:{}},denied);
  assert.equal(denied.statusCode,401);
  const r=response();
  await handler({session:{shopOwnerId:42}},r);
  assert.deepEqual(params,[[42]]);
  assert.equal(r.body.demoPagesRemaining,3);
  assert.equal(r.body.demoPagesUsed,7);
});

test("admin UI includes five subscription choices and manual Demo usage tracking",()=>{
  const html=fs.readFileSync(path.resolve(__dirname,"..","admin-dashboard.html"),"utf8");
  assert.match(html,/Demo — 10 free prints/);
  assert.match(html,/Starter — ₹49/);
  assert.match(html,/Pro — ₹99/);
  assert.match(html,/Business — ₹199/);
  assert.match(html,/Pay Per Page — ₹0\.15/);
  assert.match(html,/Record Demo printed pages/);
  assert.match(html,/demoPagesUsed/);
  assert.match(html,/loadPlanPrices\(\)/);
  assert.match(html,/loadUsage\(\)/);
});
