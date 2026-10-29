"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const billing=require("../shop-billing");

function appWith(pool) {
  const routes={};
  const app={
    get(path,...handlers){routes["GET "+path]=handlers;},
    put(path,...handlers){routes["PUT "+path]=handlers;},
    post(path,...handlers){routes["POST "+path]=handlers;}
  };
  billing.installShopBilling(app,pool);
  return routes;
}

function reply(){
  return {
    statusCode:200,body:null,headers:{},
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;},
    set(key,value){this.headers[key]=value;return this;}
  };
}
function shopReq(body={},id="5"){
  return {session:{shopOwnerId:42},params:{id},body};
}

test("the shop price list defaults to ₹3 B&W, ₹5 Aadhaar B&W and ₹10 colour",()=>{
  assert.deepEqual(billing.DEFAULT_RATES_PAISE,{bw:300,aadhaar_bw:500,color:1000});
  assert.deepEqual(billing.ratesFromRow({}),{bw:3,aadhaarBw:5,color:10});
  assert.deepEqual(billing.ratesFromRow({bw_paise:600,aadhaar_bw_paise:700,color_paise:1200}),
    {bw:6,aadhaarBw:7,color:12});
  assert.equal(billing.validRupee(3),true);
  assert.equal(billing.validRupee(3.5),false);
  assert.equal(billing.validRupee(-1),false);
  assert.equal(billing.validRupee(1001),false);
  assert.equal(billing.validRupee("3"),false);
});

test("charge printed pages times copies; Aadhaar card rate is per copy",()=>{
  assert.deepEqual(billing.calculateBill("bw",5,2,300),{quantity:10,totalPaise:3000});
  assert.deepEqual(billing.calculateBill("color",2,3,1000),{quantity:6,totalPaise:6000});
  assert.deepEqual(billing.calculateBill("aadhaar_bw",1,4,500),{quantity:4,totalPaise:2000});
  assert.throws(()=>billing.calculateBill("bw",0,1,300));
  assert.throws(()=>billing.calculateBill("bw",201,1,300));
  assert.throws(()=>billing.calculateBill("color",1,11,1000));
  assert.throws(()=>billing.calculateBill("bw",1,1,0));
  assert.throws(()=>billing.calculateBill("anything",1,1,300));
});

test("create tables for per-shop rates and retained immutable-bill snapshots",async()=>{
  const sql=[];
  await billing.ensureShopBillingTables({
    async query(query){sql.push(query);return {rows:[]};}
  });
  assert.equal(sql.length,3);
  assert.match(sql[0],/shop_print_rates/);
  assert.match(sql[0],/DEFAULT 300/);
  assert.match(sql[0],/DEFAULT 500/);
  assert.match(sql[0],/DEFAULT 1000/);
  assert.match(sql[1],/shop_print_bills/);
  assert.match(sql[1],/order_id BIGINT UNIQUE REFERENCES test_file_orders\(id\) ON DELETE SET NULL/);
  assert.match(sql[1],/payment_status VARCHAR/);
  assert.match(sql[1],/total_paise BIGINT/);
});

test("public QR rate card reveals prices for the exact public shop code only",async()=>{
  let args;
  const routes=appWith({async query(sql,params){
    assert.match(sql,/WHERE s\.public_code = \$1/);
    args=params;
    return {rows:[{name:"Mahadev Enterprises",bw_paise:300,aadhaar_bw_paise:500,color_paise:1000}]};
  }});
  const r=reply();
  await routes["GET /api/public/shops/:code/pricing"][0]({
    params:{code:"a".repeat(32)}
  },r);
  assert.equal(r.body.shopName,"Mahadev Enterprises");
  assert.deepEqual(r.body.ratesRupees,{bw:3,aadhaarBw:5,color:10});
  assert.deepEqual(args,["a".repeat(32)]);
  const invalid=reply();
  await routes["GET /api/public/shops/:code/pricing"][0]({
    params:{code:"bogus"}
  },invalid);
  assert.equal(invalid.statusCode,400);
});

test("only signed-in shop owner can read and update rates",async()=>{
  let savedParams=null;
  const routes=appWith({async query(sql,params){
    if(sql.includes("INSERT INTO shop_print_rates")){
      savedParams=params;
      return {rows:[{bw_paise:300,aadhaar_bw_paise:500,color_paise:1000}]};
    }
    return {rows:[{name:"Mahadev Enterprises"}]};
  }});
  const handlers=routes["PUT /api/shop/pricing"];
  const denied=reply();
  handlers[0]({session:{}},denied,()=>{throw Error("Must not allow anonymous owner settings");});
  assert.equal(denied.statusCode,401);
  const invalid=reply();
  await handlers[1](shopReq({ratesRupees:{bw:3.25,aadhaarBw:5,color:10}}),invalid);
  assert.equal(invalid.statusCode,400);
  assert.equal(savedParams,null);
  const good=reply();
  await handlers[1](shopReq({ratesRupees:{bw:3,aadhaarBw:5,color:10}}),good);
  assert.equal(good.body.saved,true);
  assert.deepEqual(savedParams,[42,300,500,1000]);
});

test("bill is created only after owner's Printed confirmation and uses server rate + copies",async()=>{
  let selectArgs,saveArgs;
  const routes=appWith({async query(sql,params){
    if(sql.includes("SELECT o.id, o.copies")){
      selectArgs=params;
      assert.match(sql,/owner\.id = \$1 AND o\.id = \$2/);
      return {rows:[{
        id:5,copies:2,print_mode:"bw",status:"printed",shop_name:"Mahadev Enterprises",
        bw_paise:300,aadhaar_bw_paise:500,color_paise:1000
      }]};
    }
    if(sql.includes("INSERT INTO shop_print_bills")){
      saveArgs=params;
      assert.match(sql,/ON CONFLICT \(order_id\) DO NOTHING/);
      assert.match(sql,/AND o\.status = 'printed'/);
      return {rows:[{id:18}]};
    }
    throw Error("Unexpected SQL");
  }});
  const handlers=routes["POST /api/shop/test-file-orders/:id/bill"];
  const owner=reply();
  handlers[0]({session:{}},owner,()=>{throw Error("Guest cannot create bill");});
  assert.equal(owner.statusCode,401);
  const created=reply();
  await handlers[1](shopReq({category:"bw",pagesPerCopy:5,ratePaise:1,copies:99}),created);
  assert.equal(created.statusCode,201);
  assert.equal(created.body.amountPaise,3000);
  assert.equal(created.body.paymentStatus,"unpaid");
  assert.deepEqual(selectArgs,[42,"5"]);
  assert.deepEqual(saveArgs,[42,"5","Mahadev Enterprises","bw",5,2,10,300,3000]);
});

test("never issue bills for unprinted orders or mismatched colour",async()=>{
  let orderStatus="test_only",orderMode="bw",inserts=0;
  const routes=appWith({async query(sql){
    if(sql.includes("SELECT o.id, o.copies"))return {rows:[{
      copies:1,print_mode:orderMode,status:orderStatus,shop_name:"Mahadev Enterprises"
    }]};
    inserts++;
    return {rows:[{id:1}]};
  }});
  const handler=routes["POST /api/shop/test-file-orders/:id/bill"][1];
  const notPrinted=reply();
  await handler(shopReq({category:"bw",pagesPerCopy:1}),notPrinted);
  assert.equal(notPrinted.statusCode,409);
  orderStatus="printed";
  const mismatched=reply();
  await handler(shopReq({category:"color",pagesPerCopy:1}),mismatched);
  assert.equal(mismatched.statusCode,400);
  const invalidAadhaar=reply();
  await handler(shopReq({category:"aadhaar_bw",pagesPerCopy:2}),invalidAadhaar);
  assert.equal(invalidAadhaar.statusCode,400);
  assert.equal(inserts,0);
});

test("bill history, single bill and manual payment update remain shop-scoped",async()=>{
  const seen=[];
  const routes=appWith({async query(sql,params){
    seen.push({sql,params});
    if(sql.includes("UPDATE shop_print_bills")) return {rows:[{id:12,paymentStatus:"paid"}]};
    return {rows:[{id:12,orderId:5,shopName:"Mahadev Enterprises"}]};
  }});
  const listed=reply();
  await routes["GET /api/shop/bills"][1](shopReq(),listed);
  assert.equal(listed.body.bills.length,1);
  assert.match(seen[0].sql,/WHERE o\.id = \$1/);
  const bill=reply();
  await routes["GET /api/shop/bills/:id"][1](shopReq({},12),bill);
  assert.equal(bill.body.bill.id,12);
  assert.match(seen[1].sql,/o\.id = \$1 AND b\.id = \$2/);
  const paymentHandlers=routes["POST /api/shop/bills/:id/mark-paid"];
  const refused=reply();
  await paymentHandlers[1](shopReq({paymentMethod:"upi",confirmedReceipt:false},"12"),refused);
  assert.equal(refused.statusCode,400);
  const marked=reply();
  await paymentHandlers[1](shopReq({paymentMethod:"cash",confirmedReceipt:true},"12"),marked);
  assert.equal(marked.body.manualPayment,true);
  assert.equal(marked.body.bill.paymentStatus,"paid");
  assert.match(seen[2].sql,/o\.id = \$1 AND b\.id = \$2/);
  assert.deepEqual(seen[2].params,[42,"12","cash"]);
});

test("printable bill and dashboard scripts parse; simple non-GST bills are shop-only",()=>{
  const root=path.join(__dirname,"..");
  const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
  const preview=fs.readFileSync(path.join(root,"shop-bill.html"),"utf8");
  const dashboard=fs.readFileSync(path.join(root,"shop-dashboard.html"),"utf8");
  const customer=fs.readFileSync(path.join(root,"print.html"),"utf8");
  for(const html of [preview,dashboard,customer]){
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length>0);
    scripts.forEach(m=>new vm.Script(m[1]));
  }
  assert.match(server,/installShopBilling\(app, pool\)/);
  assert.match(server,/await ensureShopBillingTables\(pool\)/);
  assert.match(server,/app\.get\("\/shop-bill\.html",[\s\S]*?req\.session\.shopOwnerId/);
  assert.match(dashboard,/id="rates-form"/);
  assert.match(dashboard,/Create simple bill/);
  assert.match(dashboard,/owner confirmed/i);
  assert.match(customer,/id="print-rate-card"/);
  assert.match(customer,/Estimated total:/);
  assert.match(preview,/Not a GST tax invoice/);
  assert.match(preview,/confirmedReceipt:true/);
  assert.match(preview,/window\.print\(\)/);
  assert.ok(!preview.includes("innerHTML"));
});
