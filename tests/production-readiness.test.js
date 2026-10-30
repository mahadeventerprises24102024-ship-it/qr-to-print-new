"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { productionReadiness }=require("../production-readiness");
const { installPlatformAdmin, credentialVersion }=require("../platform-admin");
const bcrypt=require("bcryptjs");

const credential={
  PLATFORM_ADMIN_EMAIL:"owner@example.com",
  PLATFORM_ADMIN_PASSWORD_HASH:bcrypt.hashSync("only-for-tests-not-a-real-secret",4)
};
const storage={
  ENABLE_TEST_UPLOADS:"true",
  ENABLE_GUEST_TEST_UPLOADS:"true",
  FILE_STORAGE_ENDPOINT:"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
  FILE_STORAGE_BUCKET:"test-files",
  FILE_STORAGE_ACCESS_KEY_ID:"dummy-test-access-key",
  FILE_STORAGE_SECRET_ACCESS_KEY:"dummy-test-secret-key"
};

test("production release stays closed even with all sample storage flags present",()=>{
  const result=productionReadiness({...storage,...credential,NODE_ENV:"production",ENABLE_REAL_DOCUMENT_UPLOADS:"true"});
  assert.equal(result.productionReady,false);
  assert.equal(result.canAcceptRealIdentityDocuments,false);
  assert.equal(result.documentUploads,"SAMPLE_ONLY");
  assert.equal(result.printRelease,"OWNER_VERIFIED_BROWSER_DIALOG_ONLY");
  assert.equal(result.checks.find(c=>c.id==="private_storage").ready,true);
  assert.equal(result.checks.find(c=>c.id==="guest_sample_upload").ready,true);
  for(const id of ["malware_scan","isolated_rendering","retention","payment_settlement","printer_queue"]){
    assert.equal(result.checks.find(c=>c.id===id).ready,false,id+" must fail closed");
  }
  assert.equal(JSON.stringify(result).includes(storage.FILE_STORAGE_SECRET_ACCESS_KEY),false);
  assert.equal(JSON.stringify(result).includes(storage.FILE_STORAGE_ACCESS_KEY_ID),false);
  const unset=productionReadiness({});
  assert.equal(unset.checks.find(c=>c.id==="private_storage").ready,false);
  assert.equal(unset.checks.find(c=>c.id==="guest_sample_upload").ready,false);
});

test("readiness API is protected by the existing super admin session guard",()=>{
  const routes={};
  const app={get:(p,...handlers)=>{routes[p]=handlers},post(){}};
  installPlatformAdmin(app,{query:async()=>({rows:[]})},{...credential,...storage});
  const handlers=routes["/api/platform/production-readiness"];
  assert.equal(handlers.length,2);
  const unauthorized={
    session:{},status(code){this.code=code;return this;},
    json(data){this.body=data;return this;}
  };
  handlers[0](unauthorized,unauthorized,()=>{throw Error("Unauthorized request passed");});
  assert.equal(unauthorized.code,401);
  const req={session:{
    platformAdminEmail:"owner@example.com",
    platformAdminCredentialVersion:credentialVersion(credential.PLATFORM_ADMIN_PASSWORD_HASH)
  }};
  const result={set(field,value){this[field]=value;return this},json(body){this.body=body;return this}};
  let passed=false;
  handlers[0](req,result,()=>{passed=true});
  assert.equal(passed,true);
  handlers[1](req,result);
  assert.equal(result.body.productionReady,false);
  assert.equal(result.body.checks.length,7);
  assert.equal(result["Cache-Control"],"private, no-store");
});

test("admin dashboard displays readiness results without rendering arbitrary HTML",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","admin-dashboard.html"),"utf8");
  assert.match(html,/id="readiness-summary"/);
  assert.match(html,/id="readiness-checks"/);
  assert.match(html,/request\("\/api\/platform\/production-readiness"\)/);
  assert.match(html,/loadReadiness\(\)/);
  const code=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(code);
  assert.doesNotThrow(()=>new Function(code[1]));
  assert.match(html,/output\.replaceChildren\(\)/);
  assert.doesNotMatch(html,/readinessChecks\.innerHTML/);
});
