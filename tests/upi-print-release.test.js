"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const {installUpiPrintPayments}=require("../upi-print-payments");
function install(rows){
  const routes={}, queries=[];
  const app={
    get(p,...handlers){routes["GET "+p]=handlers;},
    post(p,...handlers){routes["POST "+p]=handlers;},
    put(p,...handlers){routes["PUT "+p]=handlers;}
  };
  installUpiPrintPayments(app,{
    async query(sql,args){
      queries.push({sql,args});
      return {rows};
    }
  });
  return {routes,queries};
}
function response(){
  return {code:200,data:null,headers:{},
    status(code){this.code=code;return this;},
    set(key,value){this.headers[key]=value;return this;},
    json(body){this.data=body;return this;}
  };
}
const endpoint="GET /api/shop/test-file-orders/:id/print-permission";
const authed={session:{shopOwnerId:23},params:{id:"19"}};
test("only a logged-in shop owner may read payment-gated print permissions",async()=>{
  const h=install([{order_status:"accepted",upi_status:null}]);
  const unauth=response();
  h.routes[endpoint][0]({session:{},params:{id:"19"}},unauth,()=>{throw Error("Auth bypass")});
  assert.equal(unauth.code,401);
  const invalid=response();
  await h.routes[endpoint].at(-1)({...authed,params:{id:"not-an-id"}},invalid);
  assert.equal(invalid.code,400);
  const notFound=response();
  const missing=install([]);
  await missing.routes[endpoint].at(-1)(authed,notFound);
  assert.equal(notFound.code,404);
});

test("UPI quote locks SAMPLE print until owner confirms actual bank receipt",async()=>{
  for(const status of ["awaiting_payment","customer_claimed","rejected"]){
    const h=install([{order_status:"accepted",upi_status:status}]),result=response();
    await h.routes[endpoint].at(-1)(authed,result);
    assert.equal(result.code,200,status);
    assert.equal(result.data.canPrint,false,status);
    assert.equal(result.data.requiresManualBankConfirmation,true,status);
    assert.equal(result.data.automaticPrinting,false,status);
    assert.equal(result.data.upiQuoteExists,true,status);
    assert.equal(result.headers["Cache-Control"],"private, no-store");
    assert.match(h.queries[0].sql,/owner.id=\$1 AND o.id=\$2/);
    assert.match(h.queries[0].sql,/o.file_deleted_at IS NULL/);
    assert.deepEqual(h.queries[0].args,[23,"19"]);
  }
  const paid=install([{order_status:"accepted",upi_status:"paid_manual"}]),result=response();
  await paid.routes[endpoint].at(-1)(authed,result);
  assert.equal(result.data.canPrint,true);
  assert.equal(result.data.requiresManualBankConfirmation,false);
  assert.equal(result.data.paymentMode,"upi_quote");
});

test("cash/manual SAMPLE tests stay available if NO UPI quote exists, but acceptance remains mandatory",async()=>{
  for(const status of ["accepted","test_only","printed"]){
    const h=install([{order_status:status,upi_status:null}]),out=response();
    await h.routes[endpoint].at(-1)(authed,out);
    assert.equal(out.data.canPrint,status==="accepted");
    assert.equal(out.data.paymentMode,"manual_test");
    assert.equal(out.data.upiQuoteExists,false);
  }
});
test("browser and database both reject unverified UPI print completion",()=>{
  const preview=fs.readFileSync(path.join(root,"shop-print-preview.html"),"utf8");
  const server=fs.readFileSync(path.join(root,"private-test-uploads.js"),"utf8");
  const code=preview.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(code);
  assert.doesNotThrow(()=>new Function(code[1]));
  assert.match(preview,/id="payment-release-status"/);
  assert.match(preview,/id="refresh-payment-release"/);
  assert.match(preview,/\/print-permission/);
  assert.match(preview,/if\(!permission.canPrint\)/);
  assert.match(preview,/pdfLink.hidden = hasPendingUpi/);
  assert.match(preview,/imageButton.hidden = !canPrint/);
  assert.match(preview,/paymentReleaseStatus.textContent="UPI quote created/);
  assert.match(server,/AND NOT EXISTS \(\s*SELECT 1 FROM shop_upi_test_payments p/);
  assert.match(server,/p.status <> 'paid_manual'/);
  assert.match(server,/o.file_deleted_at IS NULL/);
});
