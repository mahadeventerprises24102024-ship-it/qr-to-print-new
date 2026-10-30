"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.join(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const panel=read("shop-print-panel.html");
const server=read("server.js");
const shop=read("shop-dashboard.html");
const upload=read("private-test-uploads.js");

test("Quick Print Panel is served only through active owner page gate and never as public asset",()=>{
  assert.match(server,/app\.get\("\/shop-print-panel\.html", shopPageGate\(pool\)/);
  assert.match(server,/if \(!req\.session \|\| !req\.session\.shopOwnerId\)/);
  assert.match(server,/sendFile\(path\.join\(__dirname, "shop-print-panel\.html"\)\)/);
  const route=server.slice(
    server.indexOf('app.get("/shop-print-panel.html"'),
    server.indexOf('app.get("/shop-print-preview.html"')
  );
  assert.match(route,/Cache-Control", "private, no-store"/);
  assert.match(route,/Referrer-Policy", "no-referrer"/);
  assert.match(route,/frame-ancestors 'none'/);
  assert.match(route,/img-src blob:/);
  assert.ok(!server.includes('for (const asset of ["style.css", "app.js", "login.html", "shop-login.html", "print.html", "subscription-payment.html", "shop-print-panel.html"]'));
});
test("Customer's TEST file order appears in shop-only inbox with poll, manual Refresh and Print action",()=>{
  assert.match(panel,/fetch\("\/api\/shop\/test-file-orders"/);
  assert.match(panel,/credentials:"same-origin"/);
  assert.match(panel,/setInterval\(refreshOrders,10000\)/);
  assert.match(panel,/visibilitychange/);
  assert.match(panel,/id="refresh-orders"/);
  assert.match(panel,/id="queue-count"/);
  assert.match(panel,/Review & Accept to Print/);
  assert.match(panel,/Print Now · Manual/);
  assert.match(panel,/\/shop-print-preview\.html\?order=/);
  assert.match(panel,/valid=orders\.filter\(o=>ORDER_ID\.test\(String\(o\.id\)\)\)\.slice\(0,20\)/);
  assert.match(upload,/app\.get\("\/api\/shop\/test-file-orders", requireShopOwner/);
  assert.match(upload,/JOIN shop_owners owner ON owner\.shop_id = o\.shop_id/);
  assert.match(upload,/WHERE owner\.id = \$1/);
  assert.doesNotMatch(panel,/fetch\("\/api\/agent\//);
});
test("No customer can initiate printing; private file acceptance and paper confirmation remain required",()=>{
  assert.match(panel,/window\.open\("\/shop-print-preview\.html/);
  assert.doesNotMatch(panel,/\/mark-printed/);
  assert.doesNotMatch(panel,/\/decision"/);
  const preview=read("shop-print-preview.html");
  assert.match(preview,/id="accept-order"/);
  assert.match(preview,/const canPrint=order\.status==="accepted"/);
  assert.match(preview,/imageButton\.hidden = !canPrint/);
  assert.match(upload,/AND o\.status = 'accepted'/);
  assert.match(upload,/confirmedPaperOutput !== true/);
  assert.ok(!panel.includes("api/agent/print-customer"));
});
test("Shop-owner local file selection immediately unlocks manual Print without uploading or server printing",()=>{
  assert.match(panel,/id="local-file"/);
  assert.match(panel,/fileInput\.addEventListener\("change"/);
  assert.match(panel,/localButton\.disabled=false/);
  assert.match(panel,/file\.size>2\*1024\*1024/);
  assert.match(panel,/pdf:"application\/pdf"/);
  assert.match(panel,/png:"image\/png"/);
  assert.match(panel,/jpg:"image\/jpeg"/);
  assert.match(panel,/URL\.createObjectURL\(file\)/);
  assert.match(panel,/URL\.revokeObjectURL\(currentUrl\)/);
  assert.match(panel,/if\(!window\.confirm\(/);
  assert.match(panel,/window\.print\(\)/);
  assert.match(panel,/pdf\.target="_blank"/);
  assert.match(panel,/pdf\.rel="noopener noreferrer"/);
  assert.doesNotMatch(panel,/new FormData/);
  assert.doesNotMatch(panel,/method:"POST"/);
  assert.doesNotMatch(panel,/navigator\.usb|navigator\.serial|print\(\)\.then/);
});
test("Quick Print Panel strictly parses JavaScript and renders untrusted order metadata as text, not HTML",()=>{
  const script=panel.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  assert.match(script[1],/element\.textContent=text/);
  assert.match(script[1],/list\.replaceChildren\(\)/);
  assert.ok(!panel.includes("innerHTML"));
  assert.ok(!panel.includes("document.write"));
  assert.ok(!panel.includes("eval("));
  assert.match(panel,/testOnly|TEST|test/);
  assert.match(panel,/Aadhaar/);
  assert.match(panel,/checkStorage\(\)/);
});
test("Shop Dashboard links authenticated Quick Print Panel from overview and orders section",()=>{
  assert.match(shop,/id="open-quick-print"/);
  assert.match(shop,/href="\/shop-print-panel\.html"/);
  assert.match(shop,/Quick Print Panel — Auto-refresh incoming TEST files/);
  assert.match(shop,/target="_blank" rel="noopener noreferrer"/);
  new vm.Script(shop.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
