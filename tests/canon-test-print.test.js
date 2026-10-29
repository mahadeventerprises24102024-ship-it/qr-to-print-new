"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonTestPrintEnabled,
  handleCanonTestHeartbeat,
  installCanonTestPrintApis
} = require("../canon-test-print-api");

test("Canon test printing is disabled by default and requires explicit opt-in", () => {
  assert.equal(canonTestPrintEnabled({}), false);
  assert.equal(canonTestPrintEnabled({ ENABLE_CANON_TEST_PRINT: "false" }), false);
  assert.equal(canonTestPrintEnabled({ ENABLE_CANON_TEST_PRINT: "true" }), true);
});

test("Disabled heartbeat never checks queue or delivers print commands", async () => {
  const pool = { query() { throw Error("database must not be used"); } };
  assert.equal(await handleCanonTestHeartbeat(pool, 42, null, {}), null);
});

test("Only a fixed Canon diagnostic job is returned by a claimed DB row", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({sql, params});
      if (sql.includes("RETURNING id")) return { rows: [{ id: 12 }] };
      return { rows: [] };
    }
  };
  const job = await handleCanonTestHeartbeat(
    pool, 42, null, { ENABLE_CANON_TEST_PRINT: "true" }
  );
  assert.deepEqual(job, {id:"12", kind:"canon_g2010_fixed_test_page"});
  assert.ok(queries.some(q => q.sql.includes("FOR UPDATE SKIP LOCKED")));
  assert.ok(queries.some(q => q.sql.includes("status = 'queued'")));
  assert.ok(queries.every(q => q.params[0] === 42));
  assert.ok(!JSON.stringify(job).includes("customer"));
});

test("Invalid agent acknowledgment rejected without printing", async () => {
  const pool = { async query() { return {rows: []}; } };
  await assert.rejects(
    handleCanonTestHeartbeat(pool, 42, {id: "5; DROP TABLE", status:"submitted"},
      {ENABLE_CANON_TEST_PRINT:"true"}),
    /Invalid test print acknowledgment/
  );
  await assert.rejects(
    handleCanonTestHeartbeat(pool, 42, {id:"1",status:"finished"},
      {ENABLE_CANON_TEST_PRINT:"true"}),
    /Invalid test print acknowledgment/
  );
});

test("Ack only changes a claimed job belonging to paired shop", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) { calls.push({sql, params}); return {rows: []}; }
  };
  const result = await handleCanonTestHeartbeat(
    pool, 7, {id: "31", status:"failed"},
    {ENABLE_CANON_TEST_PRINT:"true"}
  );
  assert.equal(result, null);
  const ack = calls.find(c => c.sql.includes("SET status = $3"));
  assert.ok(ack.sql.includes("shop_id = $2 AND status = 'claimed'"));
  assert.deepEqual(ack.params, ["31", 7, "failed"]);
});

test("Shop routes require a logged-in shop owner", async () => {
  const handlers = {};
  const app = {
    get(path, ...fns) {handlers["GET " + path] = fns;},
    post(path, ...fns) {handlers["POST " + path] = fns;}
  };
  installCanonTestPrintApis(app, {query: () => {throw Error("No DB for anonymous");}});
  for (const [path, fns] of Object.entries(handlers)) {
    const auth = fns[0];
    const response = {
      code: null,
      status(code) { this.code=code; return this; },
      json(value) { this.message=value; return this; }
    };
    auth({session: {}},response,()=>{throw Error("Anonymous reached next route: "+path)});
    assert.equal(response.code, 401);
  }
});
