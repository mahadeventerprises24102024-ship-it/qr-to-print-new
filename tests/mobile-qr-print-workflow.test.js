"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const customer=fs.readFileSync(path.join(root,"print.html"),"utf8");
const shop=fs.readFileSync(path.join(root,"shop-print-panel.html"),"utf8");

test("customer QR displays six print choices and Print initiates paid, reviewed workflow",()=>{
  for(const layout of ["aadhaar-front","aadhaar-back","document","four","two","full"]){
    assert.ok(customer.includes('data-print-layout="'+layout+'"'),"Missing "+layout);
  }
  assert.match(customer,/data-print-layout="aadhaar-front" disabled/);
  assert.match(customer,/data-print-layout="aadhaar-back" disabled/);
  assert.match(customer,/id="customer-photo-submit"[^>]*>🖨 Print/);
  assert.match(customer,/customer-photo-layout-orders/);
  assert.match(customer,/isMulti\?"\/customer-photo-layout-orders"/);
  assert.match(customer,/name="paymentMethod" value="cash"/);
  assert.match(customer,/name="paymentMethod" value="online"/);
  assert.match(customer,/UPI QR खुलेगा/);
  assert.match(customer,/बैंक में पैसा आने की दुकानदार/);
  assert.match(customer,/id="legacy-test-upload" hidden/);
  assert.match(customer,/असली Aadhaar/);
});
test("successful mobile SAMPLE upload shows a private receipt and easy tracking/UPI steps",()=>{
  for(const id of ["upload-success","uploaded-order-id","copy-tracking","check-upload-status","check-upload-upi","copy-tracking-status"]){
    assert.ok(customer.includes('id="'+id+'"'),"Missing "+id);
  }
  assert.match(customer,/latestUploadedOrder=\{id:result\.order\.id,token:result\.trackingToken\}/);
  assert.match(customer,/showTracking\("test-file-orders",result\.order\.id,result\.trackingToken\)/);
  assert.match(customer,/navigator\.clipboard\.writeText\(content\)/);
  assert.match(customer,/document\.getElementById\("track-submit"\)\.click\(\)/);
  assert.match(customer,/document\.getElementById\("upi-payment-check"\)\.click\(\)/);
  assert.doesNotMatch(customer,/localStorage\.setItem\(/);
  assert.match(customer,/<details id="demo-details"/);
});
test("shop print panel shows only unverified claims; no auto confirmation",()=>{
  assert.match(shop,/id="payment-count"/);
  assert.match(shop,/id="payment-alert-list"/);
  assert.match(shop,/\/api\/shop\/upi-payment\/orders/);
  assert.match(shop,/p\.status==="customer_claimed"/);
  assert.match(shop,/href="\/shop-dashboard\.html#wallet"/);
  assert.match(shop,/Check bank credit and the exact amount/);
  assert.doesNotMatch(shop,/confirmedBankCredit:true|decision:"paid_manual"/);
});
test("both mobile and shop inline Javascript parse",()=>{
  for(const html of [customer,shop]){
    const code=html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(code,"Script missing");
    assert.doesNotThrow(()=>new Function(code[1]));
  }
});
