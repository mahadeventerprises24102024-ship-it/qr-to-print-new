"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const vm=require("node:vm");
const root=path.join(__dirname,"..");
const src=fs.readFileSync(path.join(root,"upi-print-payments.js"),"utf8");
function harness(){
  const module={exports:{}},routes={};
  vm.runInNewContext(src,{
    module,URLSearchParams,console,process,
    require(name){
      if(name==="node:crypto")return crypto;
      if(name==="qrcode")return {toDataURL:async url=>"data:image/png;base64,"+Buffer.from(url).toString("base64")};
      if(name==="express-rate-limit")return ()=>((req,res,next)=>next());
      throw Error("Unexpected module "+name);
    }
  },{filename:"upi-print-payments.js"});
  const app={
    get(path,...handlers){routes["GET "+path]=handlers;},
    put(path,...handlers){routes["PUT "+path]=handlers;},
    post(path,...handlers){routes["POST "+path]=handlers;}
  };
  return {module:module.exports,app,routes,run:key=>routes[key].at(-1)};
}
function res(){
  return {statusCode:200,headers:{},body:null,
    status(n){this.statusCode=n;return this;},
    set(k,v){this.headers[k]=v;return this;},
    json(v){this.body=v;return this;}
  };
}
const code="a".repeat(32),token="b".repeat(48);
const payment={
  id:9,shop_id:3,order_id:27,vpa_snapshot:"owner@bank",
  payee_name_snapshot:"Sample Store",payment_reference:"QRTP"+"A".repeat(26),
  amount_paise:1800,pages_per_copy:3,status:"awaiting_payment",order_status:"accepted"
};
const auth={session:{shopOwnerId:42}};
const guest={params:{code,id:"27"},body:{trackingToken:token}};
test("UPI recipient VPA/payee validation and monetary amount belong to server",()=>{
  const {module:m}=harness();
  assert.equal(m.validVpa("owner@bank"),true);
  assert.equal(m.validVpa("bad"),false);
  assert.equal(m.validVpa("bad name@bank"),false);
  assert.equal(m.validPayee("My Shop"),true);
  assert.equal(m.validPayee("<script>"),false);
  assert.equal(m.rupees(1800),"18.00");
  const link=new URL(m.upiUrl("owner@bank","Sample Store",1800,payment.payment_reference));
  assert.equal(link.protocol,"upi:");
  assert.equal(link.searchParams.get("pa"),"owner@bank");
  assert.equal(link.searchParams.get("am"),"18.00");
  assert.equal(link.searchParams.get("cu"),"INR");
  assert.throws(()=>m.upiUrl("owner@bank","Sample Store",0,payment.payment_reference));
  assert.throws(()=>m.upiUrl("owner@bank","Sample Store",1800,"untrusted"));
  assert.equal(m.hashToken(token),crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(m.hashToken("invalid"),null);
  assert.equal(m.publicPayment(payment).automaticallyVerified,false);
  assert.equal(m.publicPayment(payment).automaticPrinting,false);
});
test("UPI database maintains separate per-shop payees, unique order and reference without customer UTR",async()=>{
  const {module:m}=harness();
  const sql=[];
  await m.ensureUpiPrintTables({query:async q=>{sql.push(q);return {rows:[]};}});
  assert.equal(sql.length,3);
  assert.match(sql[0],/shop_upi_payment_accounts/);
  assert.match(sql[0],/shop_id BIGINT PRIMARY KEY/);
  assert.match(sql[1],/shop_upi_test_payments/);
  assert.match(sql[1],/order_id BIGINT NOT NULL UNIQUE/);
  assert.match(sql[1],/payment_reference VARCHAR\(30\) NOT NULL UNIQUE/);
  assert.doesNotMatch(sql.join(" "),/customer_utr|upi_test_utr_unique/);
});
test("UPI recipient update only via logged-in shop owner with explicit recipient confirmation",async()=>{
  const h=harness();
  const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    calls.push({q,args});return {rows:[{vpa:"owner@bank",payeeName:"Sample Store",enabled:true}]};
  }});
  const handlers=h.routes["PUT /api/shop/upi-payment/account"];
  const denied=res();
  handlers[0]({session:{}},denied,()=>{throw Error("should not authorize")});
  assert.equal(denied.statusCode,401);
  const bad=res();
  await h.run("PUT /api/shop/upi-payment/account")({
    ...auth,body:{vpa:"owner@bank",payeeName:"Sample Store",enabled:true}
  },bad);
  assert.equal(bad.statusCode,400);
  const okay=res();
  await h.run("PUT /api/shop/upi-payment/account")({
    ...auth,body:{vpa:"owner@bank",payeeName:"Sample Store",enabled:true,confirmedRecipient:true}
  },okay);
  assert.equal(okay.statusCode,200);
  assert.match(calls[0].q,/SELECT shop_id,\$2,\$3,\$4 FROM shop_owners WHERE id=\$1/);
  assert.deepEqual(Array.from(calls[0].args),[42,"owner@bank","Sample Store",true]);
});
test("UPI immutable quote requires accepted same-shop TEST order, enabled payee, stored rate and copies",async()=>{
  const h=harness();
  const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    calls.push({q,args});
    if(q.includes("SELECT o.id,o.shop_id"))return {rows:[{
      id:27,shop_id:3,copies:2,print_mode:"bw",
      bw_paise:300,color_paise:1000,vpa:"owner@bank",payee_name:"Sample Store"
    }]};
    return {rows:[{
      order_id:27,amount_paise:1800,pages_per_copy:3,
      payment_reference:payment.payment_reference,status:"awaiting_payment"
    }]};
  }});
  const rejected=res();
  await h.run("POST /api/shop/test-file-orders/:id/upi/quote")({
    ...auth,params:{id:"27"},body:{pagesPerCopy:21,amountPaise:1}
  },rejected);
  assert.equal(rejected.statusCode,400);
  assert.equal(calls.length,0);
  const accepted=res();
  await h.run("POST /api/shop/test-file-orders/:id/upi/quote")({
    ...auth,params:{id:"27"},body:{pagesPerCopy:3,amountPaise:1}
  },accepted);
  assert.equal(accepted.statusCode,201);
  assert.equal(accepted.body.payment.amountRupees,"18.00");
  assert.match(calls[0].q,/owner\.id=\$1 AND o\.id=\$2 AND o\.status='accepted'/);
  assert.match(calls[0].q,/a.enabled=TRUE/);
  assert.match(calls[1].q,/ON CONFLICT\(order_id\) DO NOTHING/);
  assert.equal(calls[1].args[6],1800);
  assert.deepEqual(Array.from(calls[0].args),[42,"27"]);
});
test("private customer QR only after valid tracking token and exact shop, no forged paid status",async()=>{
  const h=harness();
  const queries=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    queries.push({q,args});return {rows:[payment]};
  }});
  const invalid=res();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/upi/details")({
    ...guest,body:{trackingToken:"invalid"}
  },invalid);
  assert.equal(invalid.statusCode,400);
  assert.equal(queries.length,0);
  const okay=res();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/upi/details")(guest,okay);
  assert.equal(okay.statusCode,200);
  assert.match(okay.body.payment.qrDataUri,/^data:image\/png;base64,/);
  assert.match(okay.body.payment.upiUrl,/^upi:\/\/pay\?/);
  assert.equal(okay.body.payment.automaticallyVerified,false);
  assert.match(queries[0].q,/s\.public_code=\$1 AND o\.id=\$2 AND o\.tracking_token_hash=\$3/);
  assert.deepEqual(Array.from(queries[0].args),[code,"27",h.module.hashToken(token)]);
});
test("customer I Paid notification requires private code, never UTR or automatic Paid",async()=>{
  const h=harness();
  const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    calls.push({q,args});
    return {rows:[q.includes("UPDATE")?{...payment,status:"customer_claimed"}:payment]};
  }});
  const bad=res();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/upi/claim")({
    ...guest,body:{trackingToken:"invalid"}
  },bad);
  assert.equal(bad.statusCode,400);
  const okay=res();
  await h.run("POST /api/public/shops/:code/test-file-orders/:id/upi/claim")({
    ...guest,body:{trackingToken:token}
  },okay);
  assert.equal(okay.statusCode,200);
  assert.equal(okay.body.payment.status,"customer_claimed");
  assert.equal(okay.body.payment.automaticallyVerified,false);
  assert.match(calls[1].q,/status='customer_claimed'/);
  assert.match(calls[1].q,/status IN \('awaiting_payment','rejected'\)/);
  assert.equal(calls[1].args.length,1);
  assert.doesNotMatch(calls[1].q,/customer_utr/);
  assert.doesNotMatch(calls[1].q,/paid_manual/);
});
test("shop owner can mark paid only with explicit bank receipt and matching exact amount",async()=>{
  const h=harness();const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    calls.push({q,args});return {rows:[{...payment,status:"paid_manual"}]};
  }});
  const denied=res();
  await h.run("POST /api/shop/upi-payment/orders/:id/decision")({
    ...auth,params:{id:"27"},body:{decision:"paid_manual",confirmedBankCredit:false,confirmedAmountPaise:1800}
  },denied);
  assert.equal(denied.statusCode,400);
  const okay=res();
  await h.run("POST /api/shop/upi-payment/orders/:id/decision")({
    ...auth,params:{id:"27"},body:{decision:"paid_manual",confirmedBankCredit:true,confirmedAmountPaise:1800}
  },okay);
  assert.equal(okay.statusCode,200);
  assert.equal(okay.body.payment.status,"paid_manual");
  assert.equal(okay.body.automaticPrinting,false);
  assert.equal(okay.body.printDialogUrl,"/shop-print-preview.html?order=27&autoPrint=1");
  assert.match(calls[0].q,/o.shop_id=p.shop_id/);
  assert.match(calls[0].q,/p.amount_paise=\$3/);
  assert.match(calls[0].q,/p.status='customer_claimed'/);
  assert.deepEqual(Array.from(calls[0].args),[42,"27",1800]);
});
test("UI contains customer QR and owner verification, and no automatic printing is turned on",()=>{
  const page=fs.readFileSync(path.join(root,"print.html"),"utf8");
  const owner=fs.readFileSync(path.join(root,"shop-dashboard.html"),"utf8");
  const preview=fs.readFileSync(path.join(root,"shop-print-preview.html"),"utf8");
  const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
  for(const html of [page,owner,preview]){
    const script=html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script);new vm.Script(script[1]);
  }
  assert.match(page,/id="upi-payment-qr"/);
  assert.doesNotMatch(page,/id="upi-payment-utr"/);
  assert.match(page,/मैंने पेमेंट कर दिया/);
  assert.match(page,/id="dummy-card-front"/);
  assert.match(page,/id="dummy-card-back"/);
  assert.match(page,/createDummyCardTestPage/);
  assert.match(page,/असली UPI QR/);
  assert.match(owner,/id="shop-upi-vpa"/);
  assert.match(owner,/id="shop-upi-claims"/);
  assert.match(owner,/Payment Received/);
  assert.match(owner,/autoPrint=1/);
  assert.match(preview,/authorizeAutoPrintDialog/);
  assert.match(preview,/window.print\(\)/);
  assert.match(preview,/id="upi-quote"/);
  assert.match(server,/installUpiPrintPayments\(app, pool\)/);
  assert.match(server,/await ensureUpiPrintTables\(pool\)/);
  assert.doesNotMatch(src,/Out-Printer|windows-print-agent\.js|printCanonFixedTestPage/);
  assert.doesNotMatch(src,/customer_utr|utrPattern/);
});


test("verified-payment TEST print-dialog preflight never allows unpaid, other-shop, rejected or expired files",async()=>{
  const h=harness();const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{calls.push({q,args});return {rows:[{id:27}]};}});
  const denied=res();
  const handler=h.routes["GET /api/shop/upi-payment/orders/:id/print-ready"];
  handler[0]({session:{}},denied,()=>{throw Error("unauthorized")});
  assert.equal(denied.statusCode,401);
  const okay=res();
  await h.run("GET /api/shop/upi-payment/orders/:id/print-ready")({...auth,params:{id:"27"}},okay);
  assert.equal(okay.statusCode,200);
  assert.equal(okay.body.ready,true);
  assert.equal(okay.body.openPrintDialogOnly,true);
  assert.equal(okay.body.automaticPrinting,false);
  assert.match(calls[0].q,/p.status='paid_manual'/);
  assert.match(calls[0].q,/o.status='accepted'/);
  assert.match(calls[0].q,/owner.id=\$1 AND o.id=\$2/);
  assert.match(calls[0].q,/NOW\(\)-INTERVAL '24 hours'/);
  assert.deepEqual(Array.from(calls[0].args),[42,"27"]);
  const h2=harness();
  h2.module.installUpiPrintPayments(h2.app,{query:async()=>({rows:[]})});
  const unpaid=res();
  await h2.run("GET /api/shop/upi-payment/orders/:id/print-ready")({...auth,params:{id:"27"}},unpaid);
  assert.equal(unpaid.statusCode,409);
});

test("DUMMY front/back card quote charges shop Aadhaar B&W per-copy rate and rejects multiple page count",async()=>{
  const h=harness();
  const calls=[];
  h.module.installUpiPrintPayments(h.app,{query:async(q,args)=>{
    calls.push({q,args});
    if(q.includes("SELECT o.id,o.shop_id"))return {rows:[{
      id:27,shop_id:3,copies:2,print_mode:"bw",
      document_kind:"dummy_card_front_back",
      bw_paise:300,color_paise:1000,aadhaar_bw_paise:500,
      vpa:"owner@bank",payee_name:"Sample Store"
    }]};
    return {rows:[{
      order_id:27,amount_paise:1000,pages_per_copy:1,
      payment_reference:payment.payment_reference,status:"awaiting_payment"
    }]};
  }});
  const tooMany=res();
  await h.run("POST /api/shop/test-file-orders/:id/upi/quote")({
    ...auth,params:{id:"27"},body:{pagesPerCopy:2}
  },tooMany);
  assert.equal(tooMany.statusCode,400);
  const fine=res();
  await h.run("POST /api/shop/test-file-orders/:id/upi/quote")({
    ...auth,params:{id:"27"},body:{pagesPerCopy:1}
  },fine);
  assert.equal(fine.statusCode,201);
  assert.equal(fine.body.payment.amountRupees,"10.00");
  assert.match(calls[0].q,/o.document_kind/);
  assert.match(calls[0].q,/aadhaar_bw_paise/);
  assert.equal(calls.at(-1).args[6],1000);
});
