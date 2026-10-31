"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const crypto=require("node:crypto");
const source=fs.readFileSync(path.join(__dirname,"..","upi-print-payments.js"),"utf8");
const dashboard=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");

function setup(){
  const routes={};
  const mod={exports:{}};
  vm.runInNewContext(source,{
    module:mod,URLSearchParams,console,process,
    require(name){
      if(name==="node:crypto")return crypto;
      if(name==="qrcode")return {toDataURL:async()=>"data:image/png;base64,xx"};
      if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
      throw Error("Unexpected module "+name);
    }
  },{filename:"upi-print-payments.js"});
  const app={
    get(path,...hs){routes["GET "+path]=hs},
    put(path,...hs){routes["PUT "+path]=hs},
    post(path,...hs){routes["POST "+path]=hs}
  };
  return {routes,mod:mod.exports,app};
}
const response=()=>({code:200,body:null,headers:{},status(x){this.code=x;return this},json(x){this.body=x;return this},set(k,v){this.headers[k]=v;return this}});
const route="PUT /api/shop/upi-payment/account";
test("soundbox payee requires owner authentication and self-declared QR mapping",async()=>{
  const h=setup(),calls=[];
  h.mod.installUpiPrintPayments(h.app,{query:async(sql,args)=>{
    calls.push({sql,args});
    return {rows:[{vpa:"soundboxmerchant@upi",payeeName:"Local Printer",enabled:true,paymentChannel:"paytm_soundbox",soundboxMappingDeclared:true}]};
  }});
  let denied=response();
  h.routes[route][0]({session:{}},denied,()=>{throw Error("unauthorized")});
  assert.equal(denied.code,401);
  const base={session:{shopOwnerId:12},body:{
    vpa:"soundboxmerchant@upi",payeeName:"Local Printer",enabled:true,
    confirmedRecipient:true,paymentChannel:"paytm_soundbox"
  }};
  const noMapping=response();
  await h.routes[route].at(-1)(base,noMapping);
  assert.equal(noMapping.code,400);
  assert.equal(calls.length,0);
  const allowed=response();
  await h.routes[route].at(-1)({...base,body:{...base.body,soundboxMappingDeclared:true}},allowed);
  assert.equal(allowed.code,200);
  assert.equal(allowed.body.paytmSoundboxDeviceConnectedByWebsite,false);
  assert.equal(allowed.body.paymentAutomaticallyVerified,false);
  assert.equal(allowed.body.automaticPrinting,false);
  assert.deepEqual(Array.from(calls[0].args),
    [12,"soundboxmerchant@upi","Local Printer",true,"paytm_soundbox",true]);
  assert.match(calls[0].sql,/ON CONFLICT\(shop_id\) DO UPDATE/);
  assert.match(calls[0].sql,/payment_channel=EXCLUDED.payment_channel/);
});
test("invalid payment methods and self-authored modes never enable automatic settlement",async()=>{
  const h=setup();
  let touched=0;
  h.mod.installUpiPrintPayments(h.app,{query:async()=>{touched++;return {rows:[]}}});
  const resp=response();
  await h.routes[route].at(-1)({
    session:{shopOwnerId:11},
    body:{vpa:"a1@bank",payeeName:"Test Shop",enabled:true,
      confirmedRecipient:true,paymentChannel:"unsupported",soundboxMappingDeclared:true}
  },resp);
  assert.equal(resp.code,400);
  assert.equal(touched,0);
  assert.match(source,/ownerOnly/);
  assert.match(source,/confirmedBankCredit/);
  assert.match(source,/p.status='customer_claimed'/);
});
test("Paytm Soundbox selector and warning appear on shop payment page",()=>{
  assert.match(dashboard,/id="shop-upi-channel"/);
  assert.match(dashboard,/value="paytm_soundbox"/);
  assert.match(dashboard,/id="shop-soundbox-mapped"/);
  assert.match(dashboard,/soundboxMappingDeclared/);
  assert.match(dashboard,/Paytm for Business/);
  assert.match(dashboard,/गारंटी नहीं/);
  const code=dashboard.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(code);
  assert.doesNotThrow(()=>new vm.Script(code[1]));
});
