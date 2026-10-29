"use strict";

/**
 * QR-To-Print Windows Printer Agent — CONNECTION PREVIEW ONLY
 *
 * This script only reports whether the local Windows PC is online and how many
 * printer devices Windows lists. It NEVER downloads documents or prints jobs.
 * Requires Node.js 20+, Windows PowerShell and a shop-issued pairing key.
 * The secret key remains in memory only and is not written to disk.
 */
const { spawnSync } = require("node:child_process");

const SERVER = "https://qr-to-print-new.onrender.com";
const HEARTBEAT_MS = 30_000;
const TOKEN_PATTERN = /^qrpa_[A-Za-z0-9_-]{43}$/;

function countWindowsPrinters() {
  if (process.platform !== "win32") {
    throw new Error("This preview agent is supported on Windows only");
  }

  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Printer -ErrorAction Stop | Measure-Object).Count"
  ], {
    timeout: 10_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024
  });

  if (result.error || result.status !== 0) {
    return { count: 0, warning: "Could not read installed Windows printers" };
  }

  const parsed = Number.parseInt((result.stdout || "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    return { count: 0, warning: "Printer count unavailable" };
  }

  return { count: parsed, warning: null };
}


function readClipboardKey() {
  // Read only a shop pairing key. Do not echo it or pass it as a command argument.
  if (process.platform !== "win32") return null;
  const command = "Get-Clipboard -Raw -ErrorAction SilentlyContinue";
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command
  ], {
    timeout: 10000, windowsHide: true, encoding: "utf8", maxBuffer: 512
  });
  if (result.error || result.status !== 0) return null;
  const token = (result.stdout || "").trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

function hiddenPrompt() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || !output.isTTY ||
        typeof input.setRawMode !== "function") {
      return reject(new Error("Open Windows PowerShell in an interactive terminal"));
    }

    let secret = "";
    output.write("Paste shop pairing key (hidden) and press Enter: ");
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();

    function finish(error) {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(secret.trim());
    }

    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\b" || ch === "\u007f") {
          secret = secret.slice(0, -1);
        } else if (ch >= " " && ch <= "~" && secret.length < 128) {
          secret += ch;
        }
      }
    }
    input.on("data", onData);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function heartbeat(secret, printerCount) {
  const response = await fetch(SERVER + "/api/agent/heartbeat", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secret,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ printerCount }),
    signal: AbortSignal.timeout(12_000)
  });

  const result = await response.json().catch(() => ({}));

  if (response.status === 401 || response.status === 403) {
    const error = new Error("Printer agent pairing was rejected or revoked");
    error.fatal = true;
    throw error;
  }
  if (!response.ok || result.connected !== true) {
    throw new Error(result.error || "Heartbeat request failed (" + response.status + ")");
  }
  if (result.printingEnabled !== false) {
    throw new Error("Unexpected server state. Agent stopped for safety");
  }
}

async function run() {
  console.log("\nQR-To-Print Windows Agent — connection preview");
  console.log("Does not download customer files or send print commands.");
  console.log("Keep the pairing key private. Press Ctrl+C to stop.\n");

  if (process.platform !== "win32") {
    throw new Error("Run this script on your Windows print-shop PC");
  }

  const secret = readClipboardKey() || await hiddenPrompt();
  console.log("Pairing key accepted from clipboard or hidden input.");
  if (!TOKEN_PATTERN.test(secret)) {
    throw new Error("Pairing key format is invalid. Generate a new one in Shop Dashboard");
  }

  while (true) {
    const result = countWindowsPrinters();
    if (result.warning) console.warn("Warning:", result.warning);

    try {
      await heartbeat(secret, result.count);
      console.log(
        new Date().toLocaleTimeString() +
        " — PC online; Windows printers detected: " + result.count +
        " (printing OFF)"
      );
    } catch (error) {
      if (error.fatal) throw error;
      console.error("Connection retry:", error.message);
    }

    await sleep(HEARTBEAT_MS);
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error("Agent stopped:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { countWindowsPrinters, heartbeat, readClipboardKey };
