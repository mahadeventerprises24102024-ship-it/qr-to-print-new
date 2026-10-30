"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const preview = fs.readFileSync(path.join(root, "shop-print-preview.html"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "shop-dashboard.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("print preview client JS parses and is not called from anonymous route", () => {
  const script = preview.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "Expected inline script");
  new vm.Script(script[1]);
  assert.match(server,
    /app\.get\("\/shop-print-preview\.html",[\s\S]*?req\.session\.shopOwnerId/);
  assert.match(server, /sendFile\(path\.join\(__dirname, "shop-print-preview\.html"\)\)/);
  assert.match(server, /frame-ancestors 'none'/);
  assert.match(server, /"Cache-Control", "private, no-store"/);
});

test("dashboard provides review action only from private test file order cards", () => {
  const start = dashboard.indexOf("async function loadPrivateOrders()");
  const end = dashboard.indexOf('document.getElementById("refresh-private-orders")');
  assert.ok(start >= 0 && end > start);
  const markup = dashboard.slice(start, end);
  assert.match(markup, /review\.href = "\/shop-print-preview\.html\?order="/);
  assert.match(markup, /review\.rel = "noopener noreferrer"/);
  assert.match(markup, /controls\.append\(review,download\)/);
  assert.match(markup, /controls\.append\(remove\)/);
  assert.match(markup, /for\(const decision of \["accepted","rejected"\]\)/);
  assert.match(markup, /body:JSON\.stringify\(\{decision\}\)/);
  assert.ok(!dashboard.includes("/api/agent/print-customer"));
});

test("print requests require human approval and browser print dialog", () => {
  assert.match(preview, /imageButton\.addEventListener\("click"/);
  assert.match(preview, /if \(!window\.confirm\(/);
  assert.match(preview, /window\.print\(\)/);
  assert.match(preview, /target="_blank" rel="noopener noreferrer"/);
  assert.match(preview, /Open PDF to Print/);
  assert.match(preview, /"\/api\/shop\/test-file-orders"/);
  assert.match(preview, /"\/download"/);
  assert.match(preview, /downloadResponse\.arrayBuffer\(\)/);
  assert.match(preview, /bytes\.byteLength !== expectedSize/);
  assert.ok(!preview.includes("eval("));
  assert.ok(!preview.includes("innerHTML"));
});

test("preview only supports bounded test file types and shop-owned APIs", () => {
  assert.match(preview, /pdf: "application\/pdf"/);
  assert.match(preview, /png: "image\/png"/);
  assert.match(preview, /jpeg: "image\/jpeg"/);
  assert.match(preview, /bytes\.byteLength > 2 \* 1024 \* 1024/);
  assert.match(preview, /credentials: "same-origin"/);
  assert.match(preview, /URL\.revokeObjectURL\(objectURL\)/);
});


test("private dashboard displays server-supplied printed state, not hardcoded unprinted copy", () => {
  const start = dashboard.indexOf("async function loadPrivateOrders()");
  const end = dashboard.indexOf('document.getElementById("refresh-private-orders")');
  assert.ok(start >= 0 && end > start);
  const markup = dashboard.slice(start, end);
  assert.match(markup, /printed:"PRINTED • owner confirmed physical paper"/);
  assert.match(markup, /test_only:"NEW • awaiting owner decision"/);
  assert.match(markup, /statusLabel\[order\.status\]/);
  assert.ok(!markup.includes('desc.textContent = "Private, not printed'));
  assert.ok(!dashboard.includes("PRIVATE TEST FILES • NOT PRINTED"));
});
