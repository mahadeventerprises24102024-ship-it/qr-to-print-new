"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"style.css"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

test("public homepage is a professional live shop portal, not a dummy demo landing",()=>{
  assert.match(html,/QR-TO-PRINT • ONLINE SHOP PORTAL/);
  assert.match(html,/Shop Login \/ Register/);
  assert.match(html,/Quick Print Panel/);
  assert.match(html,/Printer Setup &amp; Test/);
  assert.match(html,/Customer Shop QR/);
  assert.doesNotMatch(html,/Coming next|SHOP TEST WORKFLOW|TEST MODE:|Customer TEST Orders/i);
  assert.match(html,/ONE WEBSITE • TWO LOGINS/);
  assert.match(html,/href="\/access\.html\?role=admin"/);
  assert.match(html,/href="\/access\.html\?role=shop"/);
  assert.doesNotMatch(html,/href="\/access\.html\?role=customer"/);
});

test("all live homepage feature links resolve to explicit backend assets",()=>{
  const expected=[
    "/shop-login.html",
    "/shop-print-panel.html",
    "/shop-printer-check.html",
    "/subscription-payment.html"
  ];
  for(const route of expected){
    assert.ok(html.includes('href="'+route+'"'),"Home page should link "+route);
    assert.ok(server.includes('"'+route.slice(1)+'"'),"Server should reference served "+route);
  }
  assert.match(server,/app\.get\("\/shop-print-panel\.html", shopPageGate\(pool\)/);
  assert.match(server,/app\.get\("\/shop-printer-check\.html", shopPageGate\(pool\)/);
  assert.match(html,/Shop QR/);
  assert.doesNotMatch(html,/href="\/print\.html"/);
});

test("homepage does not misrepresent sensitive document workflow as production ready",()=>{
  assert.match(html,/SAMPLE\/TEST/);
  assert.match(html,/Private customer file uploads/);
  assert.match(html,/R2 TEST Storage/);
  assert.match(html,/असली ग्राहक के निजी दस्तावेज़ अपलोड न करें/);
  assert.match(html,/Production Printing अभी शुरू नहीं हुई है/);
  assert.match(html,/Admin अपने बैंक में रकम देखकर ही Activation करेगा/);
  assert.match(html,/href="#generator"/);
  assert.match(html,/id="qr-form"/);
  assert.match(html,/<script src="app\.js"><\/script>/);
});

test("responsive live homepage retains readable login and tool navigation",()=>{
  assert.match(css,/\.hero-actions/);
  assert.match(css,/\.site-caution/);
  assert.match(css,/\.two-role-grid/);
  assert.match(css,/\.tool-card a:focus-visible/);
  assert.match(css,/@media\(max-width:760px\)/);
});
