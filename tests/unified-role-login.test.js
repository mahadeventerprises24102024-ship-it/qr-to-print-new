"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const page=fs.readFileSync(path.join(root,"access.html"),"utf8");
const home=fs.readFileSync(path.join(root,"index.html"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

test("the homepage features one portal with three role links",()=>{
  assert.match(home,/href="\/access\.html"/);
  for(const role of ["admin","shop","customer"]){
    assert.ok(home.includes('href="/access.html?role='+role+'"'),role+" link missing");
  }
  assert.match(server,/app\.get\("\/access\.html",/);
  assert.match(server,/res\.sendFile\(path\.join\(__dirname, "access\.html"\)\)/);
  assert.match(server,/Cache-Control", "no-store"/);
});

test("unified portal has three accessible login panels with existing trusted backends",()=>{
  const config={
    admin:["/api/platform/login","/admin-dashboard.html"],
    shop:["/api/shop/login","/shop-dashboard.html"],
    customer:["/api/login","/dashboard.html"]
  };
  assert.match(page,/role="tablist"/);
  for(const [role,[endpoint,target]] of Object.entries(config)){
    assert.ok(page.includes('id="tab-'+role+'"'),role+" tab missing");
    assert.ok(page.includes('id="panel-'+role+'"'),role+" panel missing");
    assert.ok(page.includes('id="form-'+role+'"'),role+" form missing");
    assert.ok(page.includes('endpoint:"'+endpoint+'"'),role+" endpoint missing");
    assert.ok(page.includes('target:"'+target+'"'),role+" target missing");
  }
  assert.match(page,/method:"POST"/);
  assert.match(page,/credentials:"same-origin"/);
  assert.match(page,/window\.location\.assign\(roles\[role\]\.target\)/);
  assert.match(page,/message\.textContent=error\.message/);
  assert.match(page,/Object\.prototype\.hasOwnProperty\.call\(roles,role\)/);
  assert.doesNotMatch(page,/localStorage|sessionStorage|document\.cookie/);
});

test("unified login inline script parses and cannot select an unknown login endpoint",()=>{
  const scripts=Array.from(page.matchAll(/<script>([\s\S]*?)<\/script>/g));
  assert.equal(scripts.length,1);
  assert.doesNotThrow(()=>new Function(scripts[0][1]));
  assert.match(page,/if \(!Object\.prototype\.hasOwnProperty\.call\(roles,role\)\) role="shop";/);
  assert.match(page,/href="\/login\.html"/);
  assert.match(page,/href="\/shop-login\.html"/);
  assert.match(page,/असली पहचान दस्तावेज़ अपलोड न करें/);
});
