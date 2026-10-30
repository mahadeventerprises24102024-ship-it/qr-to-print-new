"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const PaytmChecksum=require("paytmchecksum");
const {
  paymentConfig,quote,upiUrl,parsePaytmAmount,ensureSubscriptionPaymentTables,
  settleSuccessfulPaytm,verifyPaytmOrder,installPaymentWebhook,installSubscriptionPayments
}=require("../subscription-payments");

const testEnv={
  PAYTM_MID:"INTEGR98765432101234",
  PAYTM_MERCHANT_KEY:"1234567890123456",
  PAYTM_WEBSITE_NAME:"WEBSTAGING",
  PAYTM_ENV:"test",
  PUBLIC_BASE_URL:"https://qr-to-print-new.onrender.com",
  UPI_PAYMENT_VPA:"merchant@paytm",
  UPI_PAYMENT_NAME:"QR To Print"
};
function resp(){
  return {
    statusCode:200,body:null,headers:{},sent:null,redirectUrl:null,
    status(n){this.statusCode=n;return this;},
    set(k,v){this.headers[k]=v;return this;},
    json(x){this.body=x;return this;},
    send(x){this.sent=x;return this;},
    type(){return this;},
    redirect(n,u){this.statusCode=n;this.redirectUrl=u;return this;},
    end(){return this;}
  };
}
function app(){const routes=new Map();const r={
  post(path,...fns){routes.set("POST "+path,fns);},
  get(path,...fns){routes.set("GET "+path,fns);}
};return {r,routes};}
function billingReq(body={},id="7"){return {body,params:{id},
  session:{billingOwnerId:12,billingShopId:4}};}
function fakeAdmin(req,res,next){if(!req.session?.platformAdminEmail)return res.status(401).json({error:"No admin"});next();}
const adminReq=(body={},id="7")=>({
  body,params:{id},session:{platformAdminEmail:"admin@example.com"}
});

test("configured Paytm uses explicit test/live modes; merchant key never exposed in public config",()=>{
  const c=paymentConfig(testEnv);
  assert.equal(c.gatewayEnabled,true);
  assert.equal(c.mode,"test");
  assert.equal(c.host,"https://securestage.paytmpayments.com");
  assert.equal(c.upiEnabled,true);
  assert.equal(paymentConfig({...testEnv,PAYTM_ENV:"live"}).host,"https://secure.paytmpayments.com");
  assert.equal(paymentConfig({...testEnv,PAYTM_MERCHANT_KEY:""}).gatewayEnabled,false);
  assert.equal(paymentConfig({...testEnv,PUBLIC_BASE_URL:"http://insecure.example"}).gatewayEnabled,false);
  assert.equal(paymentConfig({...testEnv,PAYTM_ENV:"garbage"}).mode,"test");
  assert.equal(paymentConfig({}).gatewayEnabled,false);
  const {r,routes}=app();
  installSubscriptionPayments(r,{query:async()=>({rows:[]})},fakeAdmin,testEnv);
  const out=resp();
  routes.get("GET /api/payments/config")[0]({},out);
  assert.equal(out.body.gatewayEnabled,true);
  assert.equal(JSON.stringify(out.body).includes(testEnv.PAYTM_MERCHANT_KEY),false);
  assert.equal(out.body.gatewayMode,"test");
});
test("fixed pricing and currency values cannot be chosen by the browser",()=>{
  assert.deepEqual(quote("starter",30),{planCode:"starter",durationDays:30,amountPaise:4900});
  assert.equal(quote("pro",90).amountPaise,29700);
  assert.equal(quote("business",365).amountPaise,238800);
  assert.equal(quote("demo",30),null);
  assert.equal(quote("per_page",30),null);
  assert.equal(quote("starter",91),null);
  assert.equal(quote("__proto__",30),null);
  assert.equal(parsePaytmAmount("49.00"),4900);
  assert.equal(parsePaytmAmount("49.0"),null);
  assert.equal(parsePaytmAmount("49.001"),null);
  assert.equal(parsePaytmAmount("not-money"),null);
  const url=upiUrl({vpa:"merchant@paytm",payeeName:"QR To Print",amountPaise:4900,id:9});
  assert.ok(url.startsWith("upi://pay?"));
  assert.match(url,/am=49.00/);
});
test("payment ledger migration sets immutable shop link and unique transaction references",async()=>{
  const statements=[];
  await ensureSubscriptionPaymentTables({query:async sql=>{statements.push(sql);return {rows:[]};}});
  assert.equal(statements.length,3);
  assert.match(statements[0],/platform_payment_requests/);
  assert.match(statements[0],/paytm_order_id VARCHAR\(70\) UNIQUE/);
  assert.match(statements[0],/upi_reference VARCHAR\(50\) UNIQUE/);
  assert.match(statements[0],/owner_id BIGINT NOT NULL REFERENCES shop_owners/);
  assert.match(statements[2],/gateway/);
});
test("signed Paytm status API is checked and test transactions never activate",async()=>{
  const key=testEnv.PAYTM_MERCHANT_KEY;
  const responseBody={
    resultInfo:{resultStatus:"TXN_SUCCESS"},
    orderId:"QRPT17",mid:testEnv.PAYTM_MID,txnId:"2026103001234567890",
    txnAmount:"49.00"
  };
  const sig=await PaytmChecksum.generateSignature(JSON.stringify(responseBody),key);
  let calls=0;const queries=[];
  const client={
    async query(sql,params){
      queries.push({sql,params});
      if(sql.includes("SELECT * FROM platform_payment_requests"))return {rows:[{
        id:17,kind:"paytm",amount_paise:4900,status:"pending",
        gateway_mode:"test",shop_id:4,plan_code:"starter",duration_days:30
      }]};
      return {rows:[]};
    },release(){}
  };
  const db={connect:async()=>client};
  const fakeFetch=async(url,opts)=>{
    calls++;
    assert.match(url,/securestage.paytmpayments.com\/v3\/order\/status/);
    assert.equal(opts.method,"POST");
    assert.equal(JSON.parse(opts.body).body.orderId,"QRPT17");
    return {ok:true,json:async()=>({head:{signature:sig},body:responseBody})};
  };
  const result=await verifyPaytmOrder(db,paymentConfig(testEnv),"QRPT17",fakeFetch);
  assert.equal(result.status,"test_paid");
  assert.equal(calls,1);
  assert.ok(queries.some(x=>x.sql.includes("UPDATE platform_payment_requests")));
  assert.ok(!queries.some(x=>x.sql.includes("UPDATE shops")));
  assert.ok(queries.some(x=>x.sql==="COMMIT"));
});
test("server rejects forged Paytm API signatures and amount mismatches",async()=>{
  const body={
    resultInfo:{resultStatus:"TXN_SUCCESS"},orderId:"QRPT21",
    txnId:"2026103001234567890",txnAmount:"49.00"
  };
  let connected=0;
  const db={connect:async()=>{connected++;throw Error("Should not reach database");}};
  const badFetch=async()=>({ok:true,json:async()=>({
    head:{signature:"fabricated"},body
  })});
  await assert.rejects(()=>verifyPaytmOrder(db,paymentConfig(testEnv),"QRPT21",badFetch),/signature verification failed/);
  assert.equal(connected,0);
  const good=await PaytmChecksum.generateSignature(JSON.stringify(body),testEnv.PAYTM_MERCHANT_KEY);
  const mismatchFetch=async()=>({ok:true,json:async()=>({
    head:{signature:good},body
  })});
  const mismatched=await verifyPaytmOrder(db,paymentConfig(testEnv),"QRPT22",mismatchFetch);
  assert.equal(mismatched.status,"mismatch");
  assert.equal(connected,0);
});
test("Paytm live settlement is idempotent and rejects the wrong environment",async()=>{
  const logs=[];let storedStatus="pending",mode="live";
  const client={
    async query(sql,params){
      logs.push({sql,params});
      if(sql.includes("SELECT * FROM platform_payment_requests")){
        return {rows:[{
          id:31,shop_id:4,kind:"paytm",amount_paise:9900,
          plan_code:"pro",duration_days:30,gateway_mode:mode,status:storedStatus
        }]};
      }
      if(sql.includes("UPDATE platform_payment_requests"))storedStatus=params[1];
      if(sql.includes("UPDATE shops"))return {rows:[{id:4}]};
      return {rows:[]};
    },release(){}
  };
  const db={connect:async()=>client};
  const tx={orderId:"QRPT31",txnId:"202610301234567891",currency:"INR",
    status:"TXN_SUCCESS",amountPaise:9900,gatewayMode:"test"};
  const wrongMode=await settleSuccessfulPaytm(db,tx);
  assert.equal(wrongMode.status,"not_pending");
  assert.equal(storedStatus,"pending");
  tx.gatewayMode="live";
  const settled=await settleSuccessfulPaytm(db,tx);
  assert.equal(settled.status,"paid");
  assert.equal(storedStatus,"paid");
  assert.equal(logs.filter(x=>x.sql.includes("UPDATE shops")).length,1);
  assert.equal(logs.filter(x=>x.sql.includes("INSERT INTO shop_subscription_events")).length,1);
  const repeated=await settleSuccessfulPaytm(db,tx);
  assert.equal(repeated.status,"paid");
  assert.equal(logs.filter(x=>x.sql.includes("UPDATE shops")).length,1);
});
test("pending shop owner may authenticate for payment but never gains a shop login session",async()=>{
  const {r,routes}=app();
  const db={query:async()=>({rows:[{
    id:12,shop_id:4,password_hash:await require("bcryptjs").hash("valid-demo-password",4)
  }]})};
  installSubscriptionPayments(r,db,fakeAdmin,testEnv);
  const handler=routes.get("POST /api/payments/shop-login").at(-1);
  const req={body:{email:"owner@example.com",password:"valid-demo-password"},
    session:{shopOwnerId:99,regenerate(cb){delete this.shopOwnerId;cb();},save(cb){cb();}}};
  const res=resp();
  await handler(req,res);
  assert.equal(res.body.signedIn,true);
  assert.equal(req.session.shopOwnerId,undefined);
  assert.equal(req.session.billingShopId,4);
  assert.equal(req.session.billingOwnerId,12);
});
test("shop admin payment approvals are authenticated, never automatic from UTR",()=>{
  const {r,routes}=app();
  installSubscriptionPayments(r,{query:async()=>({rows:[]})},fakeAdmin,testEnv);
  const middleware=routes.get("POST /api/platform/payment-requests/:id/approve")[0];
  const r1=resp();
  middleware({session:{billingShopId:4}},r1,()=>{throw Error("must not pass");});
  assert.equal(r1.statusCode,401);
  const r2=resp();
  middleware(adminReq(),r2,()=>{});
  assert.equal(r2.statusCode,200);
});
test("payment checkout and server modules parse without exposing merchant secrets",()=>{
  const dir=path.resolve(__dirname,"..");
  const html=fs.readFileSync(path.join(dir,"subscription-payment.html"),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  assert.match(html,/Paytm/);
  assert.match(html,/UPI QR/);
  assert.doesNotMatch(html,/Razorpay/i);
  const server=fs.readFileSync(path.join(dir,"server.js"),"utf8");
  assert.ok(server.indexOf("installPaymentWebhook(app,pool)") <
    server.indexOf('app.use(express.json'));
  assert.match(server,/ensureSubscriptionPaymentTables\(pool\)/);
});
