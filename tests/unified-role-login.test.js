"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const page=fs.readFileSync(path.join(root,"access.html"),"utf8");
const home=fs.readFileSync(path.join(root,"index.html"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

test("homepage offers ONLY super admin and shopkeeper logins",()=>{
  assert.match(home,/href="\/access\.html"/);
  for(const role of ["admin","shop"]){
    assert.ok(home.includes('href="/access.html?role='+role+'"'),role+" login link missing");
  }
  assert.doesNotMatch(home,/access\.html\?role=customer/);
  assert.doesNotMatch(home,/<h3>Customer Login<\/h3>/);
  assert.doesNotMatch(home,/THREE LOGINS|3 Logins \/ Sign In/);
  assert.match(home,/ONE WEBSITE • TWO LOGINS/);
  assert.match(server,/app\.get\("\/access\.html",/);
  assert.match(server,/res\.sendFile\(path\.join\(__dirname, "access\.html"\)\)/);
});

test("unified portal has exactly two login panels mapped to existing role APIs",()=>{
  const config={
    admin:["/api/platform/login","/admin-dashboard.html"],
    shop:["/api/shop/login","/shop-dashboard.html"]
  };
  assert.match(page,/role="tablist"/);
  for(const [role,[endpoint,target]] of Object.entries(config)){
    assert.ok(page.includes('id="tab-'+role+'"'),role+" tab missing");
    assert.ok(page.includes('id="panel-'+role+'"'),role+" panel missing");
    assert.ok(page.includes('id="form-'+role+'"'),role+" form missing");
    assert.ok(page.includes('endpoint:"'+endpoint+'"'),role+" API mapping missing");
    assert.ok(page.includes('target:"'+target+'"'),role+" dashboard mapping missing");
  }
  assert.doesNotMatch(page,/id="tab-customer"|id="panel-customer"|id="form-customer"|data-role="customer"/);
  assert.doesNotMatch(page,/endpoint:"\/api\/login"|target:"\/dashboard\.html"/);
  assert.match(page,/method:"POST"/);
  assert.match(page,/credentials:"same-origin"/);
  assert.match(page,/window\.location\.assign\(roles\[role\]\.target\)/);
  assert.match(page,/message\.textContent=error\.message/);
  assert.match(page,/Object\.prototype\.hasOwnProperty\.call\(roles,role\)/);
  assert.doesNotMatch(page,/localStorage|sessionStorage|document\.cookie/);
});

test("two-role page parses and customer guest QR workflow is still explained",()=>{
  const scripts=Array.from(page.matchAll(/<script>([\s\S]*?)<\/script>/g));
  assert.equal(scripts.length,1);
  assert.doesNotThrow(()=>new Function(scripts[0][1]));
  assert.match(page,/role="tab"/);
  assert.match(page,/role="shop"/);
  assert.match(page,/href="\/shop-login\.html"/);
  assert.match(page,/दुकान का QR स्कैन/);
  assert.match(page,/असली पहचान दस्तावेज़ अपलोड न करें/);
});

test("legacy customer sign-in and dashboard links redirect to two-login portal",()=>{
  assert.match(server,/app\.get\("\/login\.html", \(_req, res\) => \{/);
  assert.match(server,/app\.get\("\/dashboard\.html", \(_req, res\) => \{/);
  assert.match(server,/return res\.redirect\(302, "\/access\.html"\);/);
});
