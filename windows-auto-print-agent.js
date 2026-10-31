"use strict";
/**
 * QR-To-Print Windows photo-only auto-print worker.
 * Runs under one Windows user with a DPAPI-protected shop pairing token.
 * Never handles PDFs/identity files. The server issues a single-use claim
 * only after shop-owner UPI bank verification and explicit Auto Print opt-in.
 */
const {spawnSync}=require("node:child_process");
const {readSavedKey,listWindowsPrinters,countWindowsPrinters,heartbeat}=
  require("./windows-print-agent");
const SERVER="https://qr-to-print-new.onrender.com";
const TOKEN=/^qrpa_[A-Za-z0-9_-]{43}$/;
const ID=/^[1-9][0-9]{0,14}$/;
const LEASE=/^[a-f0-9]{64}$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function validateJob(job,names){
  return job && job.kind==="sanitized_customer_photo_jpeg" &&
    ID.test(String(job.id)) && LEASE.test(job.leaseToken||"") &&
    job.paperSize==="A4" &&
    typeof job.printerName==="string"&&names.includes(job.printerName)&&
    Number.isInteger(Number(job.copies)) &&
    Number(job.copies)>=1 && Number(job.copies)<=10 &&
    ["bw","color"].includes(job.printMode);
}
// Fixed PowerShell; printer name is an ENV VALUE, never interpolated into code.
// The photo is passed in a pipe, never persisted on the print-shop disk.
const PRINT_SCRIPT=[
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$printer=$env:QR_PRINT_PRINTER",
  "$copies=[int]$env:QR_PRINT_COPIES",
  "if ($copies -lt 1 -or $copies -gt 10) { throw 'Bad copies' }",
  "$allowed=Get-Printer -ErrorAction Stop | Where-Object { $_.Name -ceq $printer } | Select-Object -First 1",
  "if ($null -eq $allowed) { throw 'Selected printer not installed' }",
  "$encoded=[Console]::In.ReadToEnd()",
  "$bytes=[Convert]::FromBase64String($encoded)",
  "if ($bytes.Length -lt 8 -or $bytes.Length -gt 2097152) { throw 'Bad sanitized image size' }",
  "if ($bytes[0] -ne 255 -or $bytes[1] -ne 216 -or $bytes[2] -ne 255) { throw 'Not a sanitized JPEG' }",
  "$stream=[System.IO.MemoryStream]::new($bytes)",
  "$image=$null; $doc=$null",
  "try {",
  "  $image=[System.Drawing.Image]::FromStream($stream)",
  "  $doc=New-Object System.Drawing.Printing.PrintDocument",
  "  $doc.PrinterSettings.PrinterName=$printer",
  "  if (-not $doc.PrinterSettings.IsValid) { throw 'Printer unavailable' }",
  "  $a4=$doc.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq [System.Drawing.Printing.PaperKind]::A4 } | Select-Object -First 1",
  "  if (-not $a4) { throw 'Printer has no A4 paper option' }",
  "  $doc.DefaultPageSettings.PaperSize=$a4",
  "  $doc.DefaultPageSettings.Landscape=$false",
  "  $doc.DefaultPageSettings.Margins=[System.Drawing.Printing.Margins]::new(30,30,30,30)",
  "  $doc.PrinterSettings.Copies=[int16]$copies",
  "  $doc.PrintController=New-Object System.Drawing.Printing.StandardPrintController",
  "  $handler={",
  "    param($sender,$e)",
  "    $r=$e.MarginBounds",
  "    $scale=[Math]::Min(($r.Width/[double]$image.Width),($r.Height/[double]$image.Height))",
  "    $w=[int]([Math]::Floor($image.Width*$scale))",
  "    $h=[int]([Math]::Floor($image.Height*$scale))",
  "    $x=$r.X+[int](($r.Width-$w)/2)",
  "    $y=$r.Y+[int](($r.Height-$h)/2)",
  "    $e.Graphics.DrawImage($image,[System.Drawing.Rectangle]::new($x,$y,$w,$h))",
  "    $e.HasMorePages=$false",
  "  }.GetNewClosure()",
  "  $doc.add_PrintPage($handler)",
  "  $doc.Print()",
  "} finally {",
  "  if ($doc) { $doc.Dispose() }",
  "  if ($image) { $image.Dispose() }",
  "  $stream.Dispose()",
  "}"
].join("\n");

function spoolJpegOnWindows(bytes,job){
  if(process.platform!=="win32")return false;
  if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>2097152||
    bytes.subarray(0,3).toString("hex")!=="ffd8ff")return false;
  const env={...process.env,QR_PRINT_PRINTER:job.printerName,
    QR_PRINT_COPIES:String(job.copies)};
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive",
    "-Command",PRINT_SCRIPT],{
    env,input:bytes.toString("base64"),encoding:"utf8",timeout:90000,
    windowsHide:true,maxBuffer:2048
  });
  return !result.error&&result.status===0;
}
async function callAgent(secret,path,opts={}){
  const r=await fetch(SERVER+path,{
    method:opts.method||"POST",
    headers:{Authorization:"Bearer "+secret,Accept:"application/json",
      ...(opts.body?{"Content-Type":"application/json"}:{}),
      ...(opts.lease?{"X-Print-Lease":opts.lease}:{})},
    ...(opts.body?{body:JSON.stringify(opts.body)}:{}),
    signal:AbortSignal.timeout(opts.timeout||15000)
  });
  if([401,403].includes(r.status)){
    const err=new Error("Pairing revoked or unauthorized");err.fatal=true;throw err;
  }
  return r;
}
async function processOne(secret,names){
  const response=await callAgent(secret,"/api/agent/auto-print/claim",{body:{}});
  const parsed=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(parsed.error||"Queue unavailable");
  const job=parsed.job;
  if(!job)return null;
  // Claim cannot be reissued automatically. Never print an unrecognized job.
  let status="failed";
  try{
    if(!validateJob(job,names))throw Error("Job printer or type is not supported");
    const file=await callAgent(secret,"/api/agent/auto-print/file/"+job.id,{
      method:"GET",lease:job.leaseToken,timeout:25000
    });
    if(!file.ok||file.headers.get("content-type")?.split(";")[0]!=="image/jpeg")
      throw Error("Secure sanitized photo download rejected");
    const bytes=Buffer.from(await file.arrayBuffer());
    if(!spoolJpegOnWindows(bytes,job))throw Error("Windows declined the spool request");
    status="spooled";
  }catch(error){
    console.warn("Print claim #"+job.id+" needs shopkeeper review:",error.message);
  }
  try{
    const ack=await callAgent(secret,"/api/agent/auto-print/ack/"+job.id,{
      body:{leaseToken:job.leaseToken,result:status}
    });
    if(!ack.ok)console.warn("ACK unavailable; do NOT repeat print claim #"+job.id);
  }catch(error){
    console.warn("ACK failed; do NOT print again automatically for claim #"+job.id);
    if(error.fatal)throw error;
  }
  return {id:job.id,status};
}
async function run(){
  if(process.platform!=="win32")throw Error("Use the Windows print-shop PC");
  const secret=readSavedKey();
  if(!TOKEN.test(secret||""))throw Error("Install paired agent for this Windows user first");
  console.log("QR-To-Print Auto Print Agent: server-verified UPI, sanitized customer JPG only");
  console.log("Auto Print defaults OFF; enable in Shop Dashboard > Printers.");
  while(true){
    try{
      const p=listWindowsPrinters();
      const names=Array.isArray(p.names)?p.names:[];
      const count=p.names===null?countWindowsPrinters().count:names.length;
      await heartbeat(secret,count,null,p.names);
      if(names.length){
        const done=await processOne(secret,names);
        if(done)console.log("Print job #"+done.id+" "+done.status+
          " (spooled means Windows queue accepted, not paper verified)");
      }
    }catch(error){
      if(error.fatal)throw error;
      console.warn("Agent retry: "+error.message);
    }
    await sleep(30000);
  }
}
if(require.main===module){
  run().catch(e=>{console.error("Auto Print Agent stopped:",e.message);process.exitCode=1;});
}
module.exports={validateJob,spoolJpegOnWindows,processOne,PRINT_SCRIPT};
