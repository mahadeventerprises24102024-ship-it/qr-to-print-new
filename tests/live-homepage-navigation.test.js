"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"style.css"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

test("home page no longer incorrectly calls implemented Shop features Coming next",()=>{
  assert.doesNotMatch(html,/Coming next/i);
  assert.doesNotMatch(html,/File upload and shop printing are planned for a later step/i);
  assert.doesNotMatch(html,/secure shop dashboard will be built after the public tools/i);
  assert.match(html,/Shop Login \/ Register/);
  assert.match(html,/Quick Print Panel/);
  assert.match(html,/Printer Setup &amp; Test/);
  assert.match(html,/Customer TEST Orders/);
});

test("all home page print navigation routes match explicit server assets",()=>{
  const expected=[
    "/shop-login.html",
    "/shop-print-panel.html",
    "/shop-printer-check.html",
    "/subscription-payment.html"
  ];
  for(const route of expected){
    assert.ok(html.includes('href="'+route+'"'),"Home page should link "+route);
    assert.ok(server.includes('"/'+route.slice(1)+'"'),"Server should serve "+route);
  }
  assert.match(server,/app\.get\("\/shop-print-panel\.html", shopPageGate\(pool\)/);
  assert.match(server,/app\.get\("\/shop-printer-check\.html", shopPageGate\(pool\)/);
  assert.match(html,/shop's own|Shop QR|अपना अनोखा Shop QR/);
  assert.doesNotMatch(html,/href="\/print\.html"/);
});

test("home page differentiates TEST customer requests and manual approved printing",()=>{
  assert.match(html,/TEST MODE/);
  assert.match(html,/Private customer file uploads/);
  assert.match(html,/R2 TEST Storage/);
  assert.match(html,/Manual Print/);
  assert.match(html,/असली ग्राहक के निजी दस्तावेज़ अपलोड न करें/);
  assert.match(html,/Admin वास्तविक बैंक पेमेंट जाँचकर/);
  assert.match(html,/href="#generator"/);
  assert.match(html,/id="qr-form"/);
  assert.match(html,/<script src="app\.js"><\/script>/);
});

test("responsive styles include CTA keyboard focus and small-screen navigation",()=>{
  assert.match(css,/\.hero-actions/);
  assert.match(css,/\.site-caution/);
  assert.match(css,/\.tool-card a:focus-visible/);
  assert.match(css,/@media\(max-width:760px\)/);
});
