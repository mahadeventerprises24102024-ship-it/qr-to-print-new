"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const crypto=require("node:crypto");

const root=path.join(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const source=read("paytm-print-payments.js");
const server=read("server.js");
const print=read("print.html");
const preview=read("shop-print-preview.html");
const opts={
  PAYTM_TEST_ENABLED:"true",
  PAYTM_MID:"INTEGR12345678900001",
  PAYTM_MERCHANT_KEY:"fake_sandbox_key_for_unit_tests_only_12345678",
  PAYTM_WEBSITE_NAME:"WEBSTAGING",
  PAYTM_CALLBACK_BASE_URL:"https://qr-to-print-new.onrender.com"
};
const shopCode="a".repeat(32);
const secret="b".repeat(48);
const orderId="27";
const merchantId="QRTPTEST_"+"A".repeat(32);
const requestToken=()=>({params:{code:shopCode,id:orderId},body:{trackingToken:secret}});
function response(){
  return {
    statusCode:200,headers:{},body:null,redirected:null,
    status(v){this.statusCode=v;return this;},
    set(k,v){this.headers[k]=v;return this;},
    json(v){this.body=v;return this;},
    send(v){this.body=v;return this;},
    redirect(code,url){this.statusCode=code;this.redirected=url;return this;}
  };
}
function makeHarness(signatureValid=true,doFetch=async()=>{throw Error("unexpected Paytm network request");}){
  const mod={exports:{}};
  const Paytm={
    generateSignature:async()=> "signed_request",
    verifySignature:async() => signatureValid
  };
  vm.runInNewContext(source,{
    module:mod,
    require(name){
      if(name==="node:crypto")return crypto;
      if(name==="express")return {urlencoded:()=>((req,res,next)=>next())};
      if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
      if(name==="paytmchecksum")return Paytm;
      throw Error("unknown dependency "+name);
    },
    URL,Buffer,console,AbortSignal,fetch:doFetch
  },{filename:"paytm-print-payments.js"});
  const routes={};
  const app={
    post(url,...handlers){routes["POST "+url]=handlers;},
    get(url,...handlers){routes["GET "+url]=handlers;}
  };
  const run=(key)=>routes[key].at(-1);
  return {mod:mod.exports,app,routes,run,doFetch};
}
function samplePayment(status="quoted"){
  return {
    id:11,shop_id:8,order_id:27,merchant_order_id:merchantId,
    amount_paise:1800,pages_per_copy:3,status,order_status:"accepted"
  };
}
function paytmResponse(body){
  return {ok:true,json:async()=>({head:{signature:"signed_gateway"},body})};
}

test("Paytm gateway stays OFF unless configured for SANDBOX with proper secrets and HTTPS",()=>{
  const {mod}=makeHarness();
  assert.equal(mod.stageConfig({}).enabled,false);
  assert.equal(mod.stageConfig({...opts,PAYTM_TEST_ENABLED:"false"}).enabled,false);
  assert.equal(mod.stageConfig({...opts,PAYTM_MERCHANT_KEY:"short"}).enabled,false);
  assert.equal(mod.stageConfig({...opts,PAYTM_CALLBACK_BASE_URL:"http://example.com"}).enabled,false);
  assert.equal(mod.stageConfig({...opts,PAYTM_CALLBACK_BASE_URL:"http://localhost:3000"}).enabled,false);
  assert.equal(mod.stageConfig(opts).enabled,true);
  assert.equal(mod.stageConfig(opts).websiteName,"WEBSTAGING");
  assert.match(source,/https:\/\/securestage\.paytmpayments\.com/);
  assert.doesNotMatch(source,/https:\/\/secure\.paytmpayments\.com/);
  assert.match(source,/const MAX_QUOTE_PAISE=250000/);
  assert.match(source,/PAYTM_TEST_ENABLED/);
  const {app,routes}=makeHarness();
  app.get=app.get.bind(app);
  const dummy={query:async()=>({rows:[]})};
  const cfg=mod.stageConfig(opts);
  assert.equal(cfg.enabled,true);
  const h=makeHarness();
  h.mod.installPaytmTestPayments(h.app,dummy,opts);
  const res=response();
  h.run("GET /api/paytm-print/config")({},res);
  assert.equal(res.body.realMoney,false);
  assert.equal(res.body.printOnPayment,false);
  assert.equal(res.body.environment,"sandbox");
  assert.equal(JSON.stringify(res.body).includes(opts.PAYTM_MERCHANT_KEY),false);
});

test("tracking token uses hash and invalid values cannot access other shop orders",async()=>{
  const {mod}=makeHarness();
  assert.equal(mod.trackingHash("wrong"),null);
  assert.equal(mod.trackingHash(secret),crypto.createHash("sha256").update(secret).digest("hex"));
  let queries=0;
  const h=makeHarness();
  h.mod.installPaytmTestPayments(h.app,{query:async()=>{queries++;return {rows:[]};}},opts);
  const invalid=response();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/paytm/checkout")({
    params:{code:shopCode,id:orderId},body:{trackingToken:"invalid"}
  },invalid);
  assert.equal(invalid.statusCode,400);
  assert.equal(queries,0);
  assert.match(source,/o\.tracking_token_hash=\$3/);
  assert.match(source,/s\.public_code=\$1 AND o\.id=\$2/);
  assert.match(source,/JOIN test_file_orders o ON o\.id=p\.order_id AND o\.shop_id=p\.shop_id/);
});

test("owner quote validates page count, tenant id, accepted file, saved prices and idempotency",async()=>{
  const h=makeHarness();
  let recorded=[];
  const pool={query:async(sql,values)=>{
    recorded.push({sql,values});
    if(sql.includes("SELECT o.id,o.shop_id"))return {rows:[{
      id:27,shop_id:8,copies:2,print_mode:"bw",bw_paise:300,color_paise:1000
    }]};
    if(sql.includes("INSERT INTO shop_paytm_test_payments"))return {rows:[{
      order_id:27,pages_per_copy:3,amount_paise:1800,status:"quoted"
    }]};
    throw Error("Unexpected SQL");
  }};
  h.mod.installPaytmTestPayments(h.app,pool,opts);
  const handlers=h.routes["POST /api/shop/test-file-orders/:id/paytm/quote"];
  const noLogin=response();handlers[0]({session:{}},noLogin,()=>{throw Error("must deny");});
  assert.equal(noLogin.statusCode,401);
  const wrong=response();
  await handlers.at(-1)({session:{shopOwnerId:4},params:{id:orderId},body:{pagesPerCopy:21}},wrong);
  assert.equal(wrong.statusCode,400);
  assert.equal(recorded.length,0);
  const ok=response();
  await handlers.at(-1)({session:{shopOwnerId:4},params:{id:orderId},body:{pagesPerCopy:3}},ok);
  assert.equal(ok.statusCode,201);
  assert.equal(ok.body.payment.amountRupees,"18.00");
  assert.equal(ok.body.payment.automaticPrinting,false);
  assert.deepEqual(Array.from(recorded[0].values),[4,orderId]);
  assert.match(recorded[0].sql,/o\.status='accepted'/);
  assert.match(recorded[0].sql,/owner\.id=\$1 AND o\.id=\$2/);
  assert.match(recorded[1].sql,/ON CONFLICT \(order_id\) DO NOTHING/);
  assert.equal(recorded[1].values[4],1800);
  assert.match(recorded[1].values[2],/^QRTPTEST_[A-F0-9]{32}$/);
});

test("Paytm signed status success must match MID, merchant reference, money amount and txn ID",async()=>{
  const gatewayBody={
    mid:opts.PAYTM_MID,orderId:merchantId,txnAmount:"18.00",
    txnId:"TESTTXN1234567890",
    resultInfo:{resultStatus:"TXN_SUCCESS",resultCode:"01"}
  };
  const h=makeHarness(true,async()=>paytmResponse(gatewayBody));
  const ok=await h.mod.statusFromPaytm(samplePayment("pending"),h.mod.stageConfig(opts),h.doFetch);
  assert.equal(ok.status,"paid");
  assert.equal(ok.txnId,"TESTTXN1234567890");
  const mismatched=makeHarness(true,async()=>paytmResponse({...gatewayBody,txnAmount:"1.00"}));
  await assert.rejects(()=>mismatched.mod.statusFromPaytm(
    samplePayment("pending"),mismatched.mod.stageConfig(opts),mismatched.doFetch
  ),/amount, MID or order mismatch/);
  const notSigned=makeHarness(false,async()=>paytmResponse(gatewayBody));
  await assert.rejects(()=>notSigned.mod.statusFromPaytm(
    samplePayment("pending"),notSigned.mod.stageConfig(opts),notSigned.doFetch
  ),/Invalid Paytm response signature/);
  const pending=makeHarness(true,async()=>paytmResponse({
    ...gatewayBody,resultInfo:{resultStatus:"PENDING",resultCode:"400"}
  }));
  assert.equal((await pending.mod.statusFromPaytm(
    samplePayment("pending"),pending.mod.stageConfig(opts),pending.doFetch
  )).status,"pending");
  assert.equal(h.mod.amountMatches("18.00",1800),true);
  assert.equal(h.mod.amountMatches("18.01",1800),false);
  assert.equal(h.mod.amountMatches("18",1800),false);
});

test("reconciliation updates Paid only after verified signed Paytm query, atomically",async()=>{
  const gatewayBody={
    mid:opts.PAYTM_MID,orderId:merchantId,txnAmount:"18.00",txnId:"TESTTXN987654321",
    resultInfo:{resultStatus:"TXN_SUCCESS",resultCode:"01"}
  };
  const h=makeHarness(true,async()=>paytmResponse(gatewayBody));
  const statements=[];
  const pool={query:async(sql,args)=>{statements.push({sql,args});return {rows:[{id:11}]};}};
  const status=await h.mod.reconcile(pool,samplePayment("pending"),h.mod.stageConfig(opts),h.doFetch);
  assert.equal(status,"paid");
  assert.equal(statements.length,1);
  assert.match(statements[0].sql,/status='paid'/);
  assert.match(statements[0].sql,/WHERE merchant_order_id=\$1 AND status <> 'paid'/);
  assert.deepEqual(Array.from(statements[0].args),[merchantId,"TESTTXN987654321"]);
  const duplicate=await h.mod.reconcile(pool,samplePayment("paid"),h.mod.stageConfig(opts),h.doFetch);
  assert.equal(duplicate,"paid");
  assert.equal(statements.length,1);
  assert.match(source,/paytm_txn_id VARCHAR\(80\) UNIQUE/);
});

test("Paytm callback must verify signed incoming form and independent signed provider query",async()=>{
  const h=makeHarness(false);
  let queried=0;
  h.mod.installPaytmTestPayments(h.app,{query:async()=>{queried++;return {rows:[samplePayment("pending")]};}},opts);
  const callback=h.run("POST /api/paytm-print/callback");
  const invalid=response();
  await callback({body:{
    ORDERID:merchantId,MID:opts.PAYTM_MID,CHECKSUMHASH:"bad",STATUS:"TXN_SUCCESS"
  }},invalid);
  assert.equal(invalid.statusCode,400);
  assert.equal(queried,0);
  assert.match(server,/req\.path === "\/paytm-print\/callback"/);
  assert.match(source,/PaytmChecksum\.verifySignature\(signed,cfg\.merchantKey,body\.CHECKSUMHASH\)/);
  assert.match(source,/await reconcile\(pool,found\.rows\[0\],cfg,doFetch\)/);
});

test("Paytm checkout only for shop-accepted paid quote and never hands out any raw file",async()=>{
  const calls=[];
  const h=makeHarness(true,async(url,options)=>{
    calls.push({url,options});
    return paytmResponse({
      resultInfo:{resultStatus:"S",resultCode:"0000"},
      txnToken:"TEST_TOKEN_for_sandbox_checkout"
    });
  });
  const pool={query:async(sql,values)=>{
    if(sql.includes("SELECT p.*,o.status AS order_status"))return {rows:[samplePayment()]};
    if(sql.includes("status='initiating'"))return {rows:[{id:11}]};
    if(sql.includes("status='pending'"))return {rows:[{id:11}]};
    throw Error("Unexpected SQL query: "+sql);
  }};
  h.mod.installPaytmTestPayments(h.app,pool,opts,h.doFetch);
  const res=response();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/paytm/checkout")(
    requestToken(),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.testOnly,true);
  assert.equal(res.body.amountRupees,"18.00");
  assert.equal(res.body.environment,"sandbox");
  assert.equal(res.body.mid,opts.PAYTM_MID);
  assert.match(res.body.hostedUrl,/securestage\.paytmpayments\.com\/theia\/api\/v1\/showPaymentPage/);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/theia\/api\/v1\/initiateTransaction\?/);
  assert.equal(JSON.stringify(res.body).includes(opts.PAYTM_MERCHANT_KEY),false);
  assert.equal(JSON.stringify(res.body).includes("storage_key"),false);
  assert.doesNotMatch(source,/Out-Printer|printCanonFixedTestPage|\/api\/agent\/print/);
});

test("customer + owner HTML is valid JS and clearly identifies TEST payments, no live/automatic printing",()=>{
  new vm.Script(print.match(/<script>([\s\S]*?)<\/script>/)[1]);
  new vm.Script(preview.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.match(print,/id="paytm-test-actions"/);
  assert.match(print,/id="paytm-test-pay"/);
  assert.match(print,/id="paytm-test-status"/);
  assert.match(print,/TEST ONLY/);
  assert.match(preview,/id="paytm-quote"/);
  assert.match(preview,/pagesPerCopy:pages/);
  assert.match(preview,/id="accept-order"/);
  assert.match(source,/environment:"sandbox"/);
  assert.match(server,/ensurePaytmTestTables\(pool\)/);
  assert.match(server,/installPaytmTestPayments\(app, pool\)/);
  assert.match(read("package.json"),/"paytmchecksum": "\^1\.5\.1"/);
  assert.match(read("PAYTM_SANDBOX_SETUP.md"),/Paid does NOT automatically print/);
  assert.match(read("paytm-print-result.html"),/असली पैसा नहीं लिया जाता/);
});
