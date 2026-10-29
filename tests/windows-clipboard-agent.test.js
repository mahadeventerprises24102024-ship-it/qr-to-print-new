"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAgent(clipboardText, opts = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "windows-print-agent.js"), "utf8"
  );
  const moduleObject = { exports: {} };
  const calls = [];
  const fakeRequire = name => {
    if (name === "node:child_process") {
      return {
        spawnSync(command, args) {
          calls.push({ command, args });
          return {
            status: opts.status ?? 0,
            stdout: clipboardText || "",
            error: opts.error ?? null
          };
        }
      };
    }
    throw new Error("Unexpected module: " + name);
  };
  vm.runInNewContext(source, {
    require: fakeRequire,
    module: moduleObject,
    process: { platform: opts.platform || "win32" },
    console
  }, { filename: "windows-print-agent.js" });
  return { ...moduleObject.exports, calls };
}

test("Windows clipboard can provide the shop key without CMD paste", () => {
  const key = "qrpa_" + "a".repeat(43);
  const agent = loadAgent(key);
  assert.equal(agent.readClipboardKey(), key);
  assert.equal(agent.calls[0].command, "powershell.exe");
  const argumentsText = agent.calls[0].args.join(" ");
  assert.ok(argumentsText.includes("Get-Clipboard"));
  assert.ok(!argumentsText.includes(key));
});

test("Invalid clipboard content is not accepted", () => {
  assert.equal(loadAgent("not a pairing key").readClipboardKey(), null);
  assert.equal(loadAgent("qrpa_" + "a".repeat(40)).readClipboardKey(), null);
  assert.equal(loadAgent("Bearer qrpa_" + "a".repeat(43)).readClipboardKey(), null);
});

test("Empty or inaccessible clipboard does not crash agent", () => {
  assert.equal(loadAgent("").readClipboardKey(), null);
  assert.equal(loadAgent("", { status: 1 }).readClipboardKey(), null);
  assert.equal(loadAgent("", { error: new Error("cannot execute") }).readClipboardKey(), null);
});

test("Clipboard only read on Windows", () => {
  const agent = loadAgent("qrpa_" + "a".repeat(43), { platform: "linux" });
  assert.equal(agent.readClipboardKey(), null);
  assert.equal(agent.calls.length, 0);
});
