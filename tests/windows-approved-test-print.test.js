"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const { createHash }=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const printing=require("../windows-approved-test-print");

function sampleJob(type="jpeg", bytes=Buffer.from([255,216,255,1,2,3,255,217])){
  return {kind:"approved_private_test_file",id:"12",
    fileType:type,fileBytes:bytes.length,
    sha256:createHash("sha256").update(bytes).digest("hex"),
    copies:1,printMode:"bw",pdfMaxPages:2};
}

test("requires fixed shape with bounded copies/pages and no arbitrary commands",()=>{
  const good=sampleJob();assert.equal(printing.validJob(good),true);
  assert.equal(printing.validJob({...good,copies:10}),false);
  assert.equal(printing.validJob({...good,id:"12;rm"}),false);
  assert.equal(printing.validJob({...good,fileType:"exe"}),false);
  assert.equal(printing.validJob({...good,pdfMaxPages:999}),false);
  assert.equal(printing.validJob({...good,fileBytes:3*1024*1024}),false);
  assert.equal(printing.validJob({...good,printMode:"shell"}),false);
});

test("rejects wrong file signatures before calling any Windows renderer",()=>{
  const jpeg=Buffer.from([255,216,255,1,2,3,255,217]);
  const pdf=Buffer.from("%PDF-1.4\nSomething\n%%EOF");
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82,1,2,3]);
  assert.equal(printing.verifyFile(jpeg,"jpeg"),true);
  assert.equal(printing.verifyFile(jpeg,"pdf"),false);
  assert.equal(printing.verifyFile(pdf,"pdf"),true);
  assert.equal(printing.verifyFile(png,"png"),true);
  assert.equal(printing.verifyFile(Buffer.from("MZhello"),"pdf"),false);
});

test("PDF and JPG printing are never silently attempted outside Windows",async()=>{
  const bytes=Buffer.from([255,216,255,1,2,3,255,217]);
  const job=sampleJob("jpeg",bytes);
  if (process.platform !== "win32") {
    assert.equal(printing.sumatraPath(),null);
    await assert.rejects(printing.printOneApprovedTestFile("secret",job),/Windows only/);
  }
});

test("agent only accepts shop-approved job signals and no public file URL",()=>{
  const agent=fs.readFileSync(path.join(__dirname,"..","windows-print-agent.js"),"utf8");
  const helper=fs.readFileSync(path.join(__dirname,"..","windows-approved-test-print.js"),"utf8");
  const preview=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");
  assert.match(agent,/supportsOwnerApprovedTestPrint: true/);
  assert.match(agent,/validJob\(response\.approvedTestJob\)/);
  assert.match(agent,/printOneApprovedTestFile\(secret, approved\)/);
  assert.match(helper,/Bearer.*secret/);
  assert.match(helper,/sha256/);
  assert.match(helper,/fs\.rmSync\(folder/);
  assert.match(helper,/spawnSync\(renderer/);
  assert.match(helper,/"-print-to"/);
  assert.match(helper,/job\.fileType === "pdf" \? \["1-2"\]/);
  assert.match(preview,/Approve & Print \(TEST\)/);
  assert.match(preview,/approved-test-print\/" \+ encodeURIComponent\(id\)/);
  const script=preview.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
});
