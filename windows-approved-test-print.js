"use strict";

// Only fixed-shape, explicitly owner-approved PRIVATE TEST jobs are permitted.
// Requires an independently installed SumatraPDF; no shell commands from server.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const FILE_LIMIT = 2 * 1024 * 1024;
const types = { pdf:"pdf", png:"png", jpeg:"jpg" };
const SERVER = "https://qr-to-print-new.onrender.com";

function validJob(j) {
  return !!j && j.kind === "approved_private_test_file" &&
    /^[1-9][0-9]{0,14}$/.test(String(j.id)) &&
    Object.prototype.hasOwnProperty.call(types, j.fileType) &&
    Number.isInteger(j.fileBytes) && j.fileBytes >= 8 &&
    j.fileBytes <= FILE_LIMIT &&
    typeof j.sha256 === "string" && /^[a-f0-9]{64}$/.test(j.sha256) &&
    Number.isInteger(j.copies) && j.copies >= 1 && j.copies <= 2 &&
    ["bw","color"].includes(j.printMode) && j.pdfMaxPages === 2;
}

function verifyFile(bytes, type) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > FILE_LIMIT) return false;
  if (type === "pdf") return bytes.subarray(0,5).toString("ascii") === "%PDF-" &&
    bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from("%%EOF"));
  if (type === "png") return bytes.subarray(0,8).equals(
    Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.subarray(12,16).toString("ascii") === "IHDR";
  if (type === "jpeg") return bytes[0]===255 && bytes[1]===216 &&
    bytes[2]===255 && bytes[bytes.length-2]===255 &&
    bytes[bytes.length-1]===217;
  return false;
}

function sumatraPath(env = process.env, fileExists = fs.existsSync) {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(env.ProgramFiles || "C:\\Program Files", "SumatraPDF", "SumatraPDF.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SumatraPDF", "SumatraPDF.exe"),
    path.join(env.LOCALAPPDATA || "C:\\Users\\Public\\AppData\\Local", "SumatraPDF", "SumatraPDF.exe")
  ];
  return candidates.find(p => fileExists(p)) || null;
}

function canonPrinterName() {
  if (process.platform !== "win32") return null;
  const cmd = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-Printer -ErrorAction Stop | Where-Object {",
    " $_.Name -match '^Canon\\s+G2010\\s+series(?:\\s+Printer)?$'",
    "} | Select-Object -First 1",
    "if ($p) { [Console]::Out.Write($p.Name) }"
  ].join("\n");
  const output = spawnSync("powershell.exe",[
    "-NoProfile","-NonInteractive","-Command",cmd
  ],{timeout:10000,windowsHide:true,encoding:"utf8",maxBuffer:1024});
  if (output.error || output.status !== 0) return null;
  const name=(output.stdout || "").trim();
  return /^Canon\s+G2010\s+series(?:\s+Printer)?$/i.test(name) ? name : null;
}

async function downloadApprovedFile(secret, job) {
  if (!validJob(job)) throw new Error("Invalid approved test job");
  const res = await fetch(
    SERVER + "/api/agent/approved-test-print/" + job.id + "/file",{
      headers:{Authorization:"Bearer "+secret,Accept:"application/octet-stream"},
      signal:AbortSignal.timeout(20000)
    });
  if (!res.ok ||
      res.headers.get("content-type") !== "application/octet-stream" ||
      res.headers.get("x-test-file-type") !== job.fileType ||
      res.headers.get("x-test-file-sha256") !== job.sha256) {
    throw new Error("Private test file unavailable");
  }
  const length=Number(res.headers.get("content-length"));
  if (!Number.isInteger(length) || length !== job.fileBytes ||
      length > FILE_LIMIT || length < 8) {
    throw new Error("Private test file length invalid");
  }
  const bytes=Buffer.from(await res.arrayBuffer());
  if (bytes.length !== job.fileBytes ||
      createHash("sha256").update(bytes).digest("hex") !== job.sha256 ||
      !verifyFile(bytes,job.fileType)) {
    throw new Error("Private test file checksum/type verification failed");
  }
  return bytes;
}

function spoolApprovedFile(job, bytes) {
  if (!validJob(job) || !verifyFile(bytes,job.fileType) ||
      bytes.length !== job.fileBytes ||
      createHash("sha256").update(bytes).digest("hex") !== job.sha256) {
    throw new Error("Invalid private test file");
  }
  const printer=canonPrinterName();
  if (!printer) throw new Error("Canon G2010 printer not found");
  const renderer=sumatraPath();
  if (!renderer) throw new Error("Install SumatraPDF before approving a test print");

  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"qrprint-approved-"));
  try {
    const file=path.join(folder,"approved-test."+types[job.fileType]);
    fs.writeFileSync(file,bytes,{flag:"wx",mode:0o600});
    const settings=[
      ...(job.fileType === "pdf" ? ["1-2"] : []),
      String(job.copies)+"x",
      job.printMode==="color" ? "color" : "monochrome",
      "paper=A4","simplex","fit","ignore-pdf-print-settings"
    ].join(",");
    const result=spawnSync(renderer,[
      "-silent","-print-to",printer,"-print-settings",settings,file
    ],{timeout:90000,windowsHide:true,encoding:"utf8",maxBuffer:1024});
    if (result.error || result.status !== 0) {
      throw new Error("Windows print renderer could not submit the job");
    }
  } finally {
    try {fs.rmSync(folder,{recursive:true,force:true});}
    catch { console.warn("Warning: unable to remove temporary approved test file"); }
  }
}

async function printOneApprovedTestFile(secret, job) {
  if (process.platform !== "win32") throw new Error("Windows only");
  if (!validJob(job)) throw new Error("Malformed owner-approved job");
  const bytes=await downloadApprovedFile(secret,job);
  try { spoolApprovedFile(job,bytes); }
  finally { bytes.fill(0); }
  // This means submitted to the Windows print queue, NOT physical printed.
  return "submitted";
}

module.exports = {validJob,verifyFile,sumatraPath,downloadApprovedFile,
  canonPrinterName,spoolApprovedFile,printOneApprovedTestFile};
