"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const local=fs.readFileSync(path.join(root,"shop-local-print.html"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
const dashboard=fs.readFileSync(path.join(root,"shop-dashboard.html"),"utf8");
const quick=fs.readFileSync(path.join(root,"shop-print-panel.html"),"utf8");
const home=fs.readFileSync(path.join(root,"index.html"),"utf8");

test("local shop PC printing is a separate owner-gated live route",()=>{
  assert.match(server,/app\.get\("\/shop-local-print\.html", shopPageGate\(pool\), \(req, res\) => \{/);
  assert.match(server,/return res\.sendFile\(path\.join\(__dirname, "shop-local-print\.html"\)\);/);
  assert.match(server,/if \(!req\.session \|\| !req\.session\.shopOwnerId\)/);
  const route=server.slice(server.indexOf('app.get("/shop-local-print.html"'),server.indexOf("// Owner-only quick print inbox"));
  assert.match(route,/connect-src 'none'/);
  assert.match(route,/img-src blob:/);
  assert.match(route,/object-src 'none'/);
  assert.match(route,/shopPageGate\(pool\)/);
});

test("local print allows one PDF or image, or two card images on A4",()=>{
  assert.match(local,/id="job-kind"/);
  assert.match(local,/id="document-file"/);
  assert.match(local,/id="front-file"/);
  assert.match(local,/id="back-file"/);
  assert.match(local,/value="card"/);
  assert.match(local,/@page\{size:A4 portrait;margin:0\}/);
  assert.match(local,/86mm;height:54mm/);
  assert.match(local,/object-fit:contain/);
  assert.match(local,/window\.print\(\)/);
  assert.match(local,/Ctrl\+P/);
  assert.match(local,/PDF Viewer/);
});

test("no real customer file is transmitted to the cloud; owner confirms manual payment",()=>{
  const inline=local.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inline,"inline print script missing");
  assert.doesNotThrow(()=>new Function(inline[1]));
  assert.doesNotMatch(local,/fetch\(|XMLHttpRequest|sendBeacon|FormData\(|localStorage|sessionStorage|indexedDB|<form\b/i);
  assert.match(local,/URL\.createObjectURL\(file\)/);
  assert.match(local,/URL\.revokeObjectURL\(url\)/);
  assert.match(local,/id="payment-check"/);
  assert.match(local,/printButton\.disabled=!ready\|\|!payment\.checked/);
  assert.match(local,/if\(!ready\|\|!payment\.checked\|\|printButton\.disabled\)return/);
  assert.match(local,/window\.confirm\(/);
  assert.match(local,/paper\.cloneNode\(true\)/);
  assert.match(local,/window\.addEventListener\("afterprint"/);
  assert.doesNotMatch(local,/autoPrint=1|automatic printing|silent printing/i);
});

test("Print Now is clearly linked on public, shop dashboard and sample panel",()=>{
  assert.match(dashboard,/id="open-local-print"/);
  assert.match(dashboard,/href="\/shop-local-print\.html"/);
  assert.match(quick,/href="\/shop-local-print\.html"/);
  assert.match(home,/href="\/shop-local-print\.html"/);
  assert.match(quick,/SAMPLE\/TEST/);
  assert.match(home,/असली ग्राहक के निजी दस्तावेज़ अपलोड न करें/);
});
