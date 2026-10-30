"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const page=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");

test("customer dashboard is real TEST-order UI, not a coming-soon mock",()=>{
  assert.doesNotMatch(page,/coming soon|support is planned/i);
  assert.match(page,/id="openShopForm"/);
  assert.match(page,/id="trackForm"/);
  assert.match(page,/id="orders"/);
  assert.match(page,/id="qrForm"/);
  assert.doesNotMatch(page,/id="printFile"/);
  assert.match(page,/असली Aadhaar, PAN या निजी पहचान दस्तावेज़ अपलोड न करें/);
});

test("archived customer dashboard uses scoped order APIs but is no longer served",()=>{
  // Legacy customer page is retained in source for compatibility only, not served.
  assert.match(server,/app\.get\("\/dashboard\.html", \(_req, res\) => \{/);
  assert.match(server,/return res\.redirect\(302, "\/access\.html"\);/);
  assert.match(page,/api\("\/api\/me"\)/);
  assert.match(page,/api\("\/api\/customer\/test-file-orders"\)/);
  assert.ok(page.includes('"/api/public/shops/"+code+"/"+kind+"/status"'),"shop-scoped status lookup missing");
  assert.match(page,/if\(url\.origin!==location\.origin \|\| url\.pathname!=="\/print\.html"\)return null;/);
  assert.match(page,/\/\^\[a-f0-9\]\{48\}\$\/\.test\(token\)/);
  assert.match(page,/method:"POST"/);
  assert.doesNotMatch(page,/innerHTML\s*=/);
  assert.doesNotMatch(page,/localStorage|sessionStorage/);
});

test("archived customer dashboard script remains parseable",()=>{
  const code=page.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(code);
  assert.doesNotThrow(()=>new Function(code[1]));
  assert.match(page,/location\.replace\("\/access\.html\?role=customer"\)/);
  assert.match(page,/location\.assign\("\/print\.html\?shop="\+code\)/);
});
