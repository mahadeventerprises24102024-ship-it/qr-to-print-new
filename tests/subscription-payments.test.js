"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const bcrypt=require("bcryptjs");
const {
  paymentConfig,quote,upiUrl,
  ensureSubscriptionPaymentTables,installSubscriptionPayments
}=require("../subscription-payments");

const configured={
  UPI_PAYMENT_VPA:"merchant@bank",
  UPI_PAYMENT_NAME:"Mahadev Enterprises"
};
function response(){
  return {
    statusCode:200,body:null,headers:{},sent:null,
    status(n){this.statusCode=n;return this;},
    json(data){this.body=data;return this;},
    set(k,v){this.headers[k]=v;return this;},
    type(v){this.contentType=v;return this;},
    send(v){this.sent=v;return this;}
  };
}
function makeApp(pool,env=configured){
  const routes=new Map();
  const app={
    post(path,...fns){routes.set("POST "+path,fns);},
    get(path,...fns){routes.set("GET "+path,fns);}
  };
  const requireAdmin=(req,res,next)=>{
    if(!req.session?.platformAdminEmail)return res.status(401).json({error:"Admin login required"});
    next();
  };
  installSubscriptionPayments(app,pool,requireAdmin,env);
  return routes;
}
function billing(body={},id="7"){
  return {body,params:{id},session:{billingOwnerId:12,billingShopId:4}};
}
function admin(body={},id="7"){
  return {body,params:{id},session:{platformAdminEmail:"admin@example.com"}};
}
function handler(routes,method,path){const functions=routes.get(method+" "+path);assert.ok(functions,method+" "+path);return functions.at(-1);}
function runAuth(middleware,req){
  const res=response();let next=false;
  middleware(req,res,()=>{next=true;});
  return {res,next};
}
test("UPI environment must contain valid receiving VPA and beneficiary name; no hardcoded ID",()=>{
  assert.deepEqual(paymentConfig({}),{upiEnabled:false,vpa:"",payeeName:""});
  assert.deepEqual(paymentConfig(configured),{
    upiEnabled:true,vpa:"merchant@bank",payeeName:"Mahadev Enterprises"
  });
  assert.equal(paymentConfig({...configured,UPI_PAYMENT_VPA:"not-a-upi-id"}).upiEnabled,false);
  assert.equal(paymentConfig({...configured,UPI_PAYMENT_NAME:""}).upiEnabled,false);
  assert.equal(paymentConfig({...configured,UPI_PAYMENT_VPA:" bad@bank"}).vpa,"bad@bank");
  assert.equal(paymentConfig({...configured,UPI_PAYMENT_NAME:"Hello\nBank"}).upiEnabled,false);
  const routes=makeApp({query:async()=>({rows:[]})});
  const r=response();handler(routes,"GET","/api/payments/config")({},r);
  assert.deepEqual(r.body,{upiEnabled:true,signInRequired:true});
  assert.ok(!JSON.stringify(r.body).includes("merchant@bank"));
});
test("monthly checkout price is fixed server-side; Demo and Per Page not chargeable here",()=>{
  assert.deepEqual(quote("starter",30),{planCode:"starter",durationDays:30,amountPaise:4900});
  assert.equal(quote("starter",90).amountPaise,14700);
  assert.equal(quote("pro",365).amountPaise,118800);
  assert.equal(quote("business",365).amountPaise,238800);
  for(const plan of ["demo","per_page","__proto__",undefined]){
    assert.equal(quote(plan,30),null);
  }
  assert.equal(quote("starter",31),null);
  assert.equal(quote("starter","30"),null);
  const uri=upiUrl({vpa:"merchant@bank",payeeName:"Mahadev Enterprises",amountPaise:4900,id:4});
  assert.ok(uri.startsWith("upi://pay?"));
  assert.equal(new URL(uri).searchParams.get("pa"),"merchant@bank");
  assert.equal(new URL(uri).searchParams.get("am"),"49.00");
  assert.equal(new URL(uri).searchParams.get("cu"),"INR");
  assert.equal(new URL(uri).searchParams.get("tn"),"QR-To-Print plan #4");
});
test("payment schema stores a shop/owner-scoped fixed amount and beneficiary snapshot",async()=>{
  const statements=[];
  await ensureSubscriptionPaymentTables({query:async sql=>{statements.push(sql);return {rows:[]};}});
  assert.equal(statements.length,2);
  assert.match(statements[0],/CREATE TABLE IF NOT EXISTS platform_payment_requests/);
  assert.match(statements[0],/owner_id BIGINT NOT NULL REFERENCES shop_owners/);
  assert.match(statements[0],/upi_vpa VARCHAR/);
  assert.match(statements[0],/upi_payee_name VARCHAR/);
  assert.match(statements[0],/upi_reference VARCHAR\(50\) UNIQUE/);
  assert.doesNotMatch(statements[0],/razorpay|paytm|gateway/i);
});
test("billing login regenerates session and does not let pending shop open owner dashboard",async()=>{
  const password="unit-test-unique-password";
  const routes=makeApp({query:async()=>({rows:[{
    id:12,shop_id:4,password_hash:bcrypt.hashSync(password,4)
  }]})});
  const req={body:{email:"shop@example.com",password},
    session:{
      shopOwnerId:99,
      regenerate(fn){delete this.shopOwnerId;fn(null);},
      save(fn){fn(null);}
    }
  };
  const res=response();
  await handler(routes,"POST","/api/payments/shop-login")(req,res);
  assert.equal(res.body.signedIn,true);
  assert.equal(req.session.shopOwnerId,undefined);
  assert.equal(req.session.billingShopId,4);
  assert.equal(req.session.billingOwnerId,12);
  const configRoutes=makeApp({query:async()=>({rows:[]})});
  const denied=runAuth(configRoutes.get("POST /api/payments/upi-request").at(-2),{session:{}});
  assert.equal(denied.res.statusCode,401);
  assert.equal(denied.next,false);
});
test("cannot create a payment QR before merchant sets receiving UPI",async()=>{
  const routes=makeApp({query:async()=>{throw Error("DB must not be reached");}},{});
  const r=response();
  await handler(routes,"POST","/api/payments/upi-request")(billing({planCode:"starter",durationDays:30}),r);
  assert.equal(r.statusCode,503);
});
test("UPI QR request locks server price and receiving VPA snapshot, not user's requested price",async()=>{
  const queries=[];
  const routes=makeApp({query:async(sql,params)=>{
    queries.push({sql,params});
    return {rows:[{id:51,amountPaise:9900,status:"pending"}]};
  }});
  const r=response();
  await handler(routes,"POST","/api/payments/upi-request")(
    billing({planCode:"pro",durationDays:30,amountPaise:1,upiVpa:"attacker@bank"}),r
  );
  assert.equal(r.statusCode,201);
  assert.equal(r.body.amountPaise,9900);
  assert.equal(r.body.upiVpa,configured.UPI_PAYMENT_VPA);
  assert.equal(r.body.manualVerificationRequired,true);
  assert.deepEqual(queries[0].params,[4,12,"pro",30,9900,"merchant@bank","Mahadev Enterprises"]);
  const invalid=response();
  await handler(routes,"POST","/api/payments/upi-request")(billing({planCode:"demo",durationDays:30}),invalid);
  assert.equal(invalid.statusCode,400);
  assert.equal(queries.length,1);
});
test("only the same logged-in shop owner can see saved pending UPI details and QR",async()=>{
  const logs=[];
  const pool={query:async(sql,params)=>{
    logs.push({sql,params});
    return {rows:[{
      id:17,amount_paise:4900,upi_vpa:"merchant@bank",upi_payee_name:"Mahadev Enterprises"
    }]};
  }};
  const routes=makeApp(pool);
  const detailsHandler=handler(routes,"GET","/api/payments/requests/:id/upi-details");
  const r=response();await detailsHandler(billing({},17),r);
  assert.equal(r.body.upiVpa,"merchant@bank");
  assert.equal(r.body.requestId,17);
  assert.equal(r.body.qrUrl,"/api/payments/requests/17/upi-qr.png");
  assert.match(logs[0].sql,/owner_id=\$3/);
  assert.deepEqual(logs[0].params,[17,4,12]);
  const qrHandler=handler(routes,"GET","/api/payments/requests/:id/upi-qr.png");
  const qr=response();await qrHandler(billing({},17),qr);
  assert.equal(qr.contentType,"png");
  assert.ok(Buffer.isBuffer(qr.sent));
  assert.ok(qr.sent.length>300);
  assert.deepEqual(logs[1].params,[17,4,12]);
  const invalid=response();await detailsHandler(billing({},"xyz"),invalid);
  assert.equal(invalid.statusCode,400);
});
test("UTR validation, duplicate handling, and owner scoping; submission is never payment verification",async()=>{
  let queries=0;
  const routes=makeApp({query:async(sql,params)=>{
    queries++;
    assert.match(sql,/kind='upi_manual' AND status='pending'/);
    assert.deepEqual(params,["7",4,12,"123456789012"]);
    return {rows:[{id:7,status:"submitted"}]};
  }});
  const fn=handler(routes,"POST","/api/payments/requests/:id/submit-upi");
  const invalid=response();await fn(billing({utr:"abc"}),invalid);
  assert.equal(invalid.statusCode,400);
  const submitted=response();await fn(billing({utr:"123456789012"}),submitted);
  assert.equal(submitted.statusCode,200);
  assert.equal(submitted.body.submitted,true);
  assert.equal(submitted.body.verified,false);
  assert.equal(queries,1);
  const conflicts=makeApp({query:async()=>({rows:[]})});
  const twice=response();await handler(conflicts,"POST","/api/payments/requests/:id/submit-upi")(billing({utr:"123456789012"}),twice);
  assert.equal(twice.statusCode,409);
});
test("bank verification requires Super Admin, confirmed real credit, and serializes activation",async()=>{
  let state="submitted",updateCount=0,auditCount=0;
  const queries=[];
  const client={
    async query(sql,params){
      queries.push({sql,params});
      if(sql.includes("SELECT * FROM platform_payment_requests"))return {rows:[{
        id:7,kind:"upi_manual",status:state,upi_reference:"123456789012",
        shop_id:4,plan_code:"starter",duration_days:30,amount_paise:4900
      }]};
      if(sql.includes("UPDATE shops")){updateCount++;return {rows:[{id:4}]};}
      if(sql.includes("INSERT INTO shop_subscription_events")){auditCount++;return {rows:[]};}
      if(sql.includes("UPDATE platform_payment_requests"))state="paid";
      return {rows:[]};
    },release(){}
  };
  const routes=makeApp({connect:async()=>client});
  const guarded=runAuth(routes.get("POST /api/platform/payment-requests/:id/approve")[0],billing());
  assert.equal(guarded.res.statusCode,401);
  const fn=handler(routes,"POST","/api/platform/payment-requests/:id/approve");
  const bad=response();await fn(admin({confirmedReceipt:false}),bad);
  assert.equal(bad.statusCode,400);
  assert.equal(updateCount,0);
  const approved=response();await fn(admin({confirmedReceipt:true}),approved);
  assert.equal(approved.body.approved,true);
  assert.equal(updateCount,1);
  assert.equal(auditCount,1);
  assert.equal(state,"paid");
  assert.ok(queries.some(x=>x.sql.includes("FOR UPDATE")));
  assert.ok(queries.some(x=>x.sql.includes("'upi'")));
  assert.ok(queries.some(x=>x.sql==="COMMIT"));
  const again=response();await fn(admin({confirmedReceipt:true}),again);
  assert.equal(again.statusCode,409);
  assert.equal(updateCount,1);
  assert.equal(auditCount,1);
});
test("admin can reject unverified UTR without activating the shop",async()=>{
  const queries=[];
  const routes=makeApp({query:async(sql,params)=>{queries.push({sql,params});return {rows:[{id:7}]};}});
  const fn=handler(routes,"POST","/api/platform/payment-requests/:id/reject");
  const no=response();await fn(admin({confirmedRejection:false}),no);
  assert.equal(no.statusCode,400);
  const yes=response();await fn(admin({confirmedRejection:true}),yes);
  assert.equal(yes.body.rejected,true);
  assert.match(queries[0].sql,/kind='upi_manual' AND status='submitted'/);
});
test("Shop subscription UI stays manual UPI-only; Paytm sandbox is isolated to customer TEST files",()=>{
  const root=path.resolve(__dirname,"..");
  const html=fs.readFileSync(path.join(root,"subscription-payment.html"),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  assert.match(html,/Generate UPI Payment QR/);
  assert.match(html,/submit-upi/);
  assert.match(html,/upi-details/);
  assert.doesNotMatch(html,/Paytm Checkout|Razorpay|paytm-order|razorpay-order/i);
  const adminPage=fs.readFileSync(path.join(root,"admin-dashboard.html"),"utf8");
  assert.match(adminPage,/Verify bank receipt & Activate/);
  assert.match(adminPage,/Reject unverified UTR/);
  const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
  assert.match(server,/installSubscriptionPayments\(app,pool,requireAdmin\)/);
  assert.match(server,/await ensureSubscriptionPaymentTables\(pool\)/);
  assert.doesNotMatch(server,/installPaymentWebhook/);
  const packageJSON=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  assert.equal(packageJSON.dependencies.paytmchecksum,"^1.5.1");
  const paytm=fs.readFileSync(path.join(root,"paytm-print-payments.js"),"utf8");
  assert.match(paytm,/PAYTM_TEST_ENABLED/);
  assert.match(paytm,/shop_paytm_test_payments/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,"subscription-payments.js"),"utf8"),/paytmchecksum|paytm-print/);
});
