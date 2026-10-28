"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadModule() {
  const code = fs.readFileSync(path.join(__dirname, "..", "private-test-uploads.js"), "utf8");
  const fakeMulter = () => ({ single: () => (req, res, callback) => callback(null) });
  fakeMulter.memoryStorage = () => ({});

  class Command {
    constructor(input) { this.input = input; }
  }

  const fakeRequire = name => {
    if (name === "node:crypto") return require("node:crypto");
    if (name === "multer") return fakeMulter;
    if (name === "express-rate-limit") return () => (req, res, next) => next();
    if (name === "@aws-sdk/client-s3") return {
      S3Client: class { async send() { return {}; } },
      PutObjectCommand: Command,
      GetObjectCommand: Command,
      DeleteObjectCommand: Command
    };
    throw new Error("Unexpected dependency: " + name);
  };

  const moduleObject = { exports: {} };
  vm.runInNewContext(code, {
    module: moduleObject,
    require: fakeRequire,
    Buffer,
    URL,
    process,
    console
  }, { filename: "private-test-uploads.js" });
  return moduleObject.exports;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    set(key, value) { this.headers[key] = value; return this; }
  };
}

test("storage stays disabled until explicit setup", () => {
  const mod = loadModule();
  const env = {
    ENABLE_TEST_UPLOADS: "true",
    FILE_STORAGE_ENDPOINT: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
    FILE_STORAGE_BUCKET: "test-private-documents",
    FILE_STORAGE_ACCESS_KEY_ID: "key",
    FILE_STORAGE_SECRET_ACCESS_KEY: "secret"
  };
  assert.equal(mod.storageSettings(env).enabled, true);
  assert.equal(mod.storageSettings({ ...env, ENABLE_TEST_UPLOADS: "false" }).enabled, false);
  assert.equal(mod.storageSettings({
    ...env, FILE_STORAGE_ENDPOINT: "https://example.com"
  }).enabled, false);
  assert.equal(mod.storageSettings({
    ...env, FILE_STORAGE_SECRET_ACCESS_KEY: ""
  }).enabled, false);
});

test("rejects mismatched and malformed file content", () => {
  const mod = loadModule();
  const jpeg = Buffer.from([255, 216, 255, 1, 2, 3, 255, 217]);
  assert.equal(mod.detectSafeFile({
    buffer: jpeg, mimetype: "image/jpeg", originalname: "test.jpg"
  }), "jpeg");
  assert.equal(mod.detectSafeFile({
    buffer: jpeg, mimetype: "image/png", originalname: "test.jpg"
  }), null);
  assert.equal(mod.detectSafeFile({
    buffer: jpeg, mimetype: "image/jpeg", originalname: "test.exe"
  }), null);
  assert.equal(mod.detectSafeFile({
    buffer: Buffer.from("%PDF-fake"), mimetype: "application/pdf",
    originalname: "test.pdf"
  }), null);
  assert.equal(mod.detectSafeFile({
    buffer: Buffer.alloc(mod.MAX_FILE_BYTES + 1),
    mimetype: "application/pdf", originalname: "test.pdf"
  }), null);
});

test("customer upload requires login and private storage", () => {
  const mod = loadModule();
  const routes = {};
  const app = {
    get: (url, ...handlers) => { routes["GET " + url] = handlers; },
    post: (url, ...handlers) => { routes["POST " + url] = handlers; },
    delete: (url, ...handlers) => { routes["DELETE " + url] = handlers; }
  };
  const pool = { query: async () => ({ rows: [] }) };
  mod.installTestFileUploads(app, pool, { ENABLE_TEST_UPLOADS: "false" });

  const uploadRoute = routes["POST /api/public/shops/:code/test-file-orders"];
  const notLoggedIn = response();
  uploadRoute[0]({ session: {} }, notLoggedIn, () => {});
  assert.equal(notLoggedIn.statusCode, 401);

  const storageOff = response();
  uploadRoute[2]({ session: { userId: 8 } }, storageOff);
  assert.equal(storageOff.statusCode, 503);
});

test("shop orders require owner session and restrict SQL by owner id", async () => {
  const mod = loadModule();
  const routes = {};
  const app = {
    get: (url, ...handlers) => { routes["GET " + url] = handlers; },
    post: () => {},
    delete: () => {}
  };
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  }};
  mod.installTestFileUploads(app, pool, { ENABLE_TEST_UPLOADS: "false" });

  const route = routes["GET /api/shop/test-file-orders"];
  const denied = response();
  route[0]({ session: {} }, denied, () => {});
  assert.equal(denied.statusCode, 401);

  const allowed = response();
  await route[1]({ session: { shopOwnerId: 123 } }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.ok(queries.some(q =>
    q.sql.includes("JOIN shop_owners owner") &&
    q.sql.includes("WHERE owner.id = $1") &&
    q.params[0] === 123
  ));
});
