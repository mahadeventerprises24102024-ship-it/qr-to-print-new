"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const page = fs.readFileSync(path.join(__dirname, "..", "print.html"), "utf8");

test("dummy Aadhaar front and back pickers remain available without shop QR when selected", () => {
  assert.match(page, /<form id="private-upload-form">/);
  assert.match(page, /<option value="regular_test" selected>/);
  assert.match(page, /<option value="dummy_card_front_back">/);
  assert.match(page, /<div id="regular-test-file">/);
  assert.match(page, /normalFileBox.hidden=isDummy/);
  assert.match(page, /<section id="dummy-card-test-files" hidden style=/);
  assert.match(page, /dummyBox.hidden=!isDummy/);
  assert.match(page, /id="dummy-card-front" type="file"[^>]*>/);
  assert.match(page, /id="dummy-card-back" type="file"[^>]*>/);
  assert.doesNotMatch(page, /id="dummy-card-front"[^>]*disabled/);
  assert.doesNotMatch(page, /id="dummy-card-back"[^>]*disabled/);
  assert.match(page, /updateDummyKind\(\);\s*if \(!code \|\|/);
});
test("test-only upload remains disabled until verified shop and private storage", () => {
  assert.match(page, /id="private-upload-button"[^>]*disabled>/);
  assert.match(page, /if\s*\(!config\.enabled\)\s*\{/);
  assert.match(page, /if\s*\(!config\.guestTestUploadsEnabled \|\| config\.customerLoginRequired\)/);
  assert.match(page, /if\(!verifiedCode \|\| privateButton\.disabled\) return;/);
  assert.match(page, /असली Aadhaar अपलोड न करें/);
});
