"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const src=fs.readFileSync(path.join(__dirname,"..","private-test-uploads.js"),"utf8");
const dash=fs.readFileSync(path.join(__dirname,"..","shop-dashboard.html"),"utf8");
test("R2 file deletion keeps payment and order audit records",()=>{
  const block=src.slice(src.indexOf('app.delete("/api/shop/test-file-orders/:id"'));
  assert.match(block,/DeleteObjectCommand/);
  assert.match(block,/file_deleted_at = NOW\(\)/);
  assert.doesNotMatch(block,/DELETE FROM test_file_orders/);
  assert.match(block,/owner\.id=\$1 AND o\.id=\$2/);
  assert.match(block,/retainedAuditOnly: true/);
});
test("deleted SAMPLE objects cannot be downloaded, re-accepted or marked printed",()=>{
  assert.match(src,/AND o\.file_deleted_at IS NULL/);
  assert.match(src,/o\.file_deleted_at AS "fileDeletedAt"/);
  assert.match(dash,/FILE DELETED \(audit only\)/);
  assert.match(dash,/remove\.disabled=!!order\.fileDeletedAt/);
  assert.match(dash,/if\(order\.status!=="rejected"&&!order\.fileDeletedAt\)/);
});
