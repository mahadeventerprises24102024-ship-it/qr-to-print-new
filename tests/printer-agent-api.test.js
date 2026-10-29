"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

function makeHarness() {
  const content = fs.readFileSync(
    path.join(__dirname, "..", "printer-agent-api.js"), "utf8"
  );
  const moduleObject = { exports: {} };
  vm.runInNewContext(content, {
    module: moduleObject,
    require(name) {
      if (name === "node:crypto") return nodeCrypto;
      if (name === "express-rate-limit") return () => (req, res, next) => next();
      if (name === "./canon-test-print-api") return {
        canonTestPrintEnabled: () => false,
        handleCanonTestHeartbeat: async () => null
      };
      if (name === "./approved-test-print") return {
        enabled: () => false,
        processAgentApprovedHeartbeat: async () => null
      };
      throw new Error("Unexpected dependency: " + name);
    },
    console,
    Buffer
  }, { filename: "printer-agent-api.js" });

  const routes = {};
  const app = {
    get(name, ...handlers) { routes["GET " + name] = handlers; },
    post(name, ...handlers) { routes["POST " + name] = handlers; }
  };
  return { routes, app, ...moduleObject.exports };
}

function response() {
  return {
    code: 200,
    payload: null,
    headers: {},
    status(value) { this.code = value; return this; },
    json(value) { this.payload = value; return this; },
    set(name, value) { this.headers[name] = value; return this; }
  };
}

test("shop owner login required for pairing, status and revoke", () => {
  const h = makeHarness();
  h.installAgentApis(h.app, { query: async () => ({ rows: [] }) });

  for (const key of [
    "POST /api/shop/agent/pair",
    "GET /api/shop/agent/status",
    "POST /api/shop/agent/revoke"
  ]) {
    const res = response();
    h.routes[key][0]({ session: {} }, res, () => {});
    assert.equal(res.code, 401, key);
  }
});

test("pairing returns secret once and stores only a hash", async () => {
  const h = makeHarness();
  const queries = [];
  h.installAgentApis(h.app, {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [{ shop_id: 19 }] };
    }
  });
  const res = response();
  await h.routes["POST /api/shop/agent/pair"][1]({
    session: { shopOwnerId: 9 }
  }, res);
  assert.equal(res.code, 200);
  assert.match(res.payload.token, /^qrpa_[A-Za-z0-9_-]{43}$/);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[0], 9);
  assert.match(queries[0].values[1], /^[a-f0-9]{64}$/);
  assert.ok(!queries[0].values.includes(res.payload.token));
});

test("agent heartbeat requires token, no browser Origin and numeric count", async () => {
  const h = makeHarness();
  const queries = [];
  h.installAgentApis(h.app, {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [{ shop_id: 1 }] };
    }
  });
  const route = h.routes["POST /api/agent/heartbeat"][1];
  const token = "qrpa_" + "A".repeat(43);
  const makeRequest = (count, origin, authorization) => ({
    body: { printerCount: count },
    get(name) {
      const map = { origin, authorization };
      return map[name];
    }
  });

  let res = response();
  await route(makeRequest(1, "https://malicious.example", "Bearer " + token), res);
  assert.equal(res.code, 403);

  res = response();
  await route(makeRequest(1, undefined, "Bearer bad"), res);
  assert.equal(res.code, 401);

  res = response();
  await route(makeRequest(-1, undefined, "Bearer " + token), res);
  assert.equal(res.code, 400);

  res = response();
  await route(makeRequest(3, undefined, "Bearer " + token), res);
  assert.equal(res.code, 200);
  assert.equal(res.payload.printingEnabled, false);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[1], 3);
  assert.match(queries[0].values[0], /^[a-f0-9]{64}$/);
});

test("revoked pairing key is rejected", async () => {
  const h = makeHarness();
  h.installAgentApis(h.app, {
    async query() { return { rows: [] }; }
  });

  const res = response();
  await h.routes["POST /api/agent/heartbeat"][1]({
    body: { printerCount: 0 },
    get(name) {
      return name === "authorization"
        ? "Bearer qrpa_" + "a".repeat(43) : undefined;
    }
  }, res);
  assert.equal(res.code, 401);
});

test("agent status query is filtered by shop owner id", async () => {
  const h = makeHarness();
  let recorded = null;
  h.installAgentApis(h.app, {
    async query(sql, values) {
      recorded = { sql, values };
      return { rows: [] };
    }
  });

  const res = response();
  await h.routes["GET /api/shop/agent/status"][1]({
    session: { shopOwnerId: 87 }
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.payload.paired, false);
  assert.equal(res.payload.printingEnabled, false);
  assert.match(recorded.sql, /WHERE o\.id = \$1/);
  assert.equal(recorded.values[0], 87);
});
