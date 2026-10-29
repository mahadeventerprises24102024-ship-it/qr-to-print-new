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


test("guest uploads need an independent opt-in and working private storage", () => {
  const mod = loadModule();
  const cfg = {
    ENABLE_TEST_UPLOADS: "true",
    FILE_STORAGE_ENDPOINT: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
    FILE_STORAGE_BUCKET: "test-private-documents",
    FILE_STORAGE_ACCESS_KEY_ID: "bucket-key",
    FILE_STORAGE_SECRET_ACCESS_KEY: "bucket-secret"
  };
  assert.equal(mod.guestTestUploadsEnabled(cfg), false);
  assert.equal(mod.guestTestUploadsEnabled({
    ...cfg, ENABLE_GUEST_TEST_UPLOADS: "true"
  }), true);
  assert.equal(mod.guestTestUploadsEnabled({
    ...cfg, ENABLE_TEST_UPLOADS: "false", ENABLE_GUEST_TEST_UPLOADS: "true"
  }), false);
  assert.equal(mod.guestTestUploadsEnabled({
    ...cfg, FILE_STORAGE_SECRET_ACCESS_KEY: "", ENABLE_GUEST_TEST_UPLOADS: "true"
  }), false);
});

test("guest uploads disabled by default and owner-only endpoints stay private", () => {
  const mod = loadModule();
  const routes = {};
  const app = {
    get(p,...h){routes["GET "+p]=h;},
    post(p,...h){routes["POST "+p]=h;},
    delete(p,...h){routes["DELETE "+p]=h;}
  };
  mod.installTestFileUploads(app,{query:async()=>({rows:[]})},
    { ENABLE_TEST_UPLOADS:"false", ENABLE_GUEST_TEST_UPLOADS:"true" });
  const noGuest = response();
  routes["POST /api/public/shops/:code/test-file-orders"][0](
    {session:{}},noGuest,()=>{throw Error("Guest should not be authorized");});
  assert.equal(noGuest.statusCode,401);

  const noShop = response();
  routes["GET /api/shop/test-file-orders"][0](
    {session:{}},noShop,()=>{throw Error("Shop API must require login");});
  assert.equal(noShop.statusCode,401);

  const noCustomer = response();
  routes["GET /api/customer/test-file-orders"][0](
    {session:{}},noCustomer,()=>{throw Error("Customer order list must stay protected");});
  assert.equal(noCustomer.statusCode,401);
});

test("guest test upload inserts NULL customer ID when explicitly enabled", async () => {
  const mod=loadModule();
  const env={
    ENABLE_TEST_UPLOADS:"true", ENABLE_GUEST_TEST_UPLOADS:"true",
    FILE_STORAGE_ENDPOINT:"https://"+"a".repeat(32)+".r2.cloudflarestorage.com",
    FILE_STORAGE_BUCKET:"test-private-documents",
    FILE_STORAGE_ACCESS_KEY_ID:"bucket-key",
    FILE_STORAGE_SECRET_ACCESS_KEY:"bucket-secret"
  };
  const routes={};
  const app={
    get(p,...h){routes["GET "+p]=h;},
    post(p,...h){routes["POST "+p]=h;},
    delete(p,...h){routes["DELETE "+p]=h;}
  };
  let insertValues=null;
  const pool={async query(sql,params){
    if(sql.includes("SELECT id FROM shops")) return {rows:[{id:42}]};
    if(sql.includes("COUNT(*)")) return {rows:[{total:0}]};
    if(sql.includes("INSERT INTO test_file_orders")) {
      insertValues=params;
      return {rows:[{id:13,status:"test_only"}]};
    }
    throw Error("Unexpected query: "+sql);
  }};
  mod.installTestFileUploads(app,pool,env);
  const handlers=routes["POST /api/public/shops/:code/test-file-orders"];
  const request={
    session:{},params:{code:"a".repeat(32)},
    body:{copies:"1",printMode:"bw"},
    file:{
      buffer:Buffer.from([255,216,255,1,2,3,255,217]),
      size:8,mimetype:"image/jpeg",originalname:"sample.jpg"
    }
  };
  let authorized=false;
  handlers[0](request,response(),()=>{authorized=true;});
  assert.equal(authorized,true);
  const reply=response();
  await handlers[2](request,reply);
  assert.equal(reply.statusCode,201);
  assert.equal(reply.body.guest,true);
  assert.equal(reply.body.order.id,13);
  assert.equal(insertValues[0],42);
  assert.equal(insertValues[1],null);
  assert.ok(insertValues[2].startsWith("test-uploads/42/"));
  assert.equal(insertValues[3],"jpeg");
});

test("existing database schema migration accepts a null customer id",async()=>{
  const mod=loadModule();
  const statements=[];
  const pool={async query(sql){statements.push(sql);return {rows:[]};}};
  await mod.ensureTestUploadTables(pool);
  assert.ok(statements.some(sql=>
    sql.includes("ALTER TABLE test_file_orders ALTER COLUMN customer_id DROP NOT NULL")));
});

test("customer QR page has no customer login requirement or login links",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const page=fs.readFileSync(path.join(__dirname,"..","print.html"),"utf8");
  assert.ok(page.includes("config.guestTestUploadsEnabled"));
  assert.ok(page.includes("privateForm.hidden=false"));
  assert.ok(!page.includes('id="customer-login"'));
  assert.ok(!page.includes('id="private-login-link"'));
  assert.ok(!page.includes('fetch("/api/me"'));
  const script=page.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new (require("node:vm").Script)(script[1]);
});
