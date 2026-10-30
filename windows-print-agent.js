"use strict";

/**
 * QR-To-Print Windows Printer Agent — PRINTER DISCOVERY PREVIEW ONLY
 *
 * This script reports installed printer names and may print a fixed Canon diagnostic page only after
 * an explicit authenticated shop-owner click. It NEVER downloads or prints customer documents.
 * Requires Node.js 20+, Windows PowerShell and a shop-issued pairing key.
 * The secret key remains in memory only and is not written to disk.
 */
const { spawnSync } = require("node:child_process");

const SERVER = "https://qr-to-print-new.onrender.com";
const HEARTBEAT_MS = 30_000;
const TOKEN_PATTERN = /^qrpa_[A-Za-z0-9_-]{43}$/;
const MAX_REPORTED_PRINTERS = 30;
const MAX_PRINTER_NAME = 100;

function validPrinterName(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PRINTER_NAME && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

// Fixed Windows command: never evaluate any names as commands or print files.
// Names are only forwarded to the authenticated shop's dashboard as hints.
function listWindowsPrinters() {
  if (process.platform !== "win32") {
    throw new Error("Printer discovery is supported on Windows only");
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$names = @(Get-Printer -ErrorAction Stop | Select-Object -ExpandProperty Name)",
    "$names | ConvertTo-Json -Compress"
  ].join("\n");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command
  ], {
    timeout: 10000, windowsHide: true, encoding: "utf8",
    maxBuffer: 12 * 1024
  });
  if (result.error || result.status !== 0) {
    return { names: null, warning: "Could not list Windows printers; reporting count only" };
  }
  let parsed;
  try {
    const raw=(result.stdout||"").trim();
    parsed=raw ? JSON.parse(raw) : [];
  } catch {
    return { names: null, warning: "Printer list response was unreadable; reporting count only" };
  }
  const allNames=typeof parsed==="string" ? [parsed] : parsed;
  if(!Array.isArray(allNames)||allNames.length>MAX_REPORTED_PRINTERS||
     !allNames.every(validPrinterName)||
     new Set(allNames).size!==allNames.length) {
    return { names: null, warning: "Windows printer list could not be safely reported" };
  }
  return { names: allNames, warning: null };
}

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


// Only a static diagnostic page can be printed, after shop owner consent.
function printCanonFixedTestPage() {
  if (process.platform !== "win32") {
    return { status: "failed", warning: "Windows only" };
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Get-Printer -ErrorAction Stop | Where-Object {",
    "  $_.Name -match '^Canon\\s+G2010\\s+series(?:\\s+Printer)?$'",
    "} | Select-Object -First 1",
    "if (-not $p) { throw 'Canon G2010 not found' }",
    "@(",
    "  'QR-To-Print TEST PAGE'",
    "  'Canon PIXMA G2010'",
    "  'Shop owner requested this diagnostic page.'",
    "  'No customer documents are printed.'",
    ") | Out-Printer -Name $p.Name -ErrorAction Stop"
  ].join("\n");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command
  ], {
    timeout: 20000, windowsHide: true, encoding: "utf8", maxBuffer: 1024
  });
  if (result.error || result.status !== 0) {
    return { status: "failed", warning: "Could not submit Canon G2010 test page to Windows" };
  }
  return { status: "submitted", warning: null };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function heartbeat(secret, printerCount, testPrintResult = null, printerNames = null) {
  const response = await fetch(SERVER + "/api/agent/heartbeat", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secret,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ printerCount, supportsCanonTestPrint: true,
      ...(printerNames !== null ? { printerNames } : {}),
      ...(testPrintResult ? { testPrintResult } : {}) }),
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
    throw new Error("Unexpected customer-print state. Agent stopped for safety");
  }
  return result;
}

async function run() {
  console.log("\nQR-To-Print Windows Agent — shop-owned printer discovery preview");
  console.log("Customer documents are never downloaded or printed. Owner-requested fixed Canon test page only.");
  console.log("Keep the pairing key private. Press Ctrl+C to stop.\n");

  if (process.platform !== "win32") {
    throw new Error("Run this script on your Windows print-shop PC");
  }

  const secret = readClipboardKey() || await hiddenPrompt();
  console.log("Pairing key accepted from clipboard or hidden input.");
  if (!TOKEN_PATTERN.test(secret)) {
    throw new Error("Pairing key format is invalid. Generate a new one in Shop Dashboard");
  }

  let pendingResult = null;
  while (true) {
    const discovered = listWindowsPrinters();
    if (discovered.warning) console.warn("Warning:", discovered.warning);
    const result = discovered.names !== null ?
      { count: discovered.names.length, warning: null } : countWindowsPrinters();
    if (result.warning) console.warn("Warning:", result.warning);

    try {
      const response = await heartbeat(secret, result.count, pendingResult, discovered.names);
      pendingResult = null;
      console.log(
        new Date().toLocaleTimeString() +
        " — PC online; Windows printers detected: " + result.count +
        " (customer printing OFF)"
      );
      const job = response.testPrintJob;
      if (response.canonTestPrintEnabled === true && job &&
          job.kind === "canon_g2010_fixed_test_page" &&
          /^[1-9][0-9]{0,14}$/.test(String(job.id))) {
        console.log("Canon G2010 test page approved by shop owner; submitting...");
        const printed = printCanonFixedTestPage();
        pendingResult = { id: String(job.id), status: printed.status };
        if (printed.warning) console.warn(printed.warning);
        else console.log("Test page submitted to Windows print queue (paper output not verified).");
      }
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

module.exports = { countWindowsPrinters, listWindowsPrinters, validPrinterName, heartbeat, readClipboardKey, printCanonFixedTestPage };
