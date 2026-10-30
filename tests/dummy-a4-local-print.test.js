"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const page=fs.readFileSync(path.join(__dirname,"..","print.html"),"utf8");

test("dummy card A4 preview button and script are present and syntactically valid",()=>{
  assert.match(page,/id="dummy-a4-print" class="btn" disabled/);
  assert.match(page,/id="dummy-a4-status"[^>]*role="status"/);
  const script=page.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script,"customer inline script is present");
  assert.doesNotThrow(()=>new Function(script[1]));
  assert.match(page,/dummyA4Print\.addEventListener\("click",async\(\)=>/);
  assert.match(page,/@page\{size:A4 portrait;margin:0\}/);
  assert.match(page,/title:"FRONT SAMPLE"/);
  assert.match(page,/title:"BACK SAMPLE"/);
  assert.match(page,/previewWindow\.print\(\)/);
});

test("A4 dummy test is local-only, while real private upload stays gated",()=>{
  const start=page.indexOf('dummyA4Print.addEventListener("click"');
  const end=page.indexOf("const trackForm=",start);
  assert.ok(start>0 && end>start);
  const localHandler=page.slice(start,end);
  assert.doesNotMatch(localHandler,/fetch\s*\(/);
  assert.match(localHandler,/window\.open\("","_blank"\)/);
  assert.match(localHandler,/createDummyCardTestPage/);
  assert.match(localHandler,/URL\.createObjectURL/);
  assert.match(page,/if\(!verifiedCode \|\| privateButton\.disabled\) return;/);
  assert.match(page,/असली Aadhaar अपलोड न करें/);
});
