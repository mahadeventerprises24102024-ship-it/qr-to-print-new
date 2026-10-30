"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.join(__dirname,"..");
const file=name=>fs.readFileSync(path.join(root,name),"utf8");
const agentCode=file("windows-print-agent.js");
const setup=file("setup-windows-agent-autostart.ps1");
const installCmd=file("Install-QR-To-Print-Agent.cmd");
const uninstallCmd=file("Uninstall-QR-To-Print-Agent.cmd");
const dashboard=file("shop-dashboard.html");
const server=file("server.js");

function agentHarness(platform,response){
  const calls=[];
  const moduleObject={exports:{}};
  const fakeRequire=name=>{
    if(name==="node:child_process")return {
      spawnSync(executable,args,options){
        calls.push({executable,args,options});
        return response;
      }
    };
    throw Error("Unexpected require: "+name);
  };
  const processMock={platform,argv:["node","windows-print-agent.js"]};
  vm.runInNewContext(agentCode,{
    module:moduleObject,
    require:fakeRequire,
    process:processMock,
    console,
    setTimeout,
    AbortSignal
  },{filename:"windows-print-agent.js"});
  return {agent:moduleObject.exports,calls};
}

test("Windows Agent can decrypt a saved Windows-user DPAPI secret without prompting",()=>{
  const token="qrpa_"+"x".repeat(43);
  const h=agentHarness("win32",{status:0,stdout:token,stderr:"",error:null});
  assert.equal(h.agent.readSavedKey(),token);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].executable,"powershell.exe");
  assert.ok(h.calls[0].args.includes("-NonInteractive"));
  const command=h.calls[0].args.at(-1);
  assert.match(command,/Join-Path \$env:LOCALAPPDATA/);
  assert.match(command,/pairing-key\.dpapi/);
  assert.match(command,/ConvertTo-SecureString/);
  assert.match(command,/SecureStringToBSTR/);
  assert.match(command,/ZeroFreeBSTR/);
  assert.doesNotMatch(command,/qrpa_[A-Za-z0-9_-]{43}/);
  assert.equal(h.calls[0].options.windowsHide,true);
  assert.ok(h.calls[0].options.maxBuffer<=512);
});

test("auto-start key loader fails closed on missing or bad saved key and on non-Windows",()=>{
  for(const result of [
    {status:2,stdout:""},
    {status:1,stdout:"not accessible"},
    {status:0,stdout:"not a pairing token"},
    {status:0,stdout:"qrpa_"+"a".repeat(42)}
  ]){
    const h=agentHarness("win32",result);
    assert.equal(h.agent.readSavedKey(),null);
  }
  const other=agentHarness("linux",{status:0,stdout:"qrpa_"+"x".repeat(43)});
  assert.equal(other.agent.readSavedKey(),null);
  assert.equal(other.calls.length,0);
});

test("scheduled mode never reads clipboard or asks for interactive credentials",()=>{
  assert.match(agentCode,/process\.argv\.includes\("--auto-start"\)/);
  assert.match(agentCode,/const saved = readSavedKey\(\)/);
  assert.match(agentCode,/autoStart \? null : readClipboardKey\(\)/);
  assert.match(agentCode,/autoStart \? null : await hiddenPrompt\(\)/);
  assert.match(agentCode,/No saved Windows pairing key/);
  assert.match(agentCode,/printingEnabled !== false/);
  assert.match(agentCode,/Customer documents are never downloaded or printed/);
  assert.doesNotMatch(agentCode,/\/api\/shop\/test-file-orders\/.*download/);
  new vm.Script(agentCode);
});

test("installer encrypts key with Windows user DPAPI and restricts local directory",()=>{
  assert.match(setup,/ConvertFrom-SecureString -SecureString \$secureKey/);
  assert.match(setup,/SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(setup,/Set-Acl -LiteralPath \$installDir/);
  assert.match(setup,/SecurityIdentifier/);
  assert.match(setup,/pairing-key\.dpapi/);
  assert.match(setup,/Set-Clipboard -Value ''/);
  assert.match(setup,/Read-Host 'Shop pairing key' -AsSecureString/);
  assert.match(setup,/No automatic printing or customer file downloads/);
  assert.match(setup,/nodeVersionText -match/);
  assert.match(setup,/Run from your normal unelevated Windows account/);
  assert.doesNotMatch(setup,/UPI_PAYMENT_VPA|DATABASE_URL|SESSION_SECRET/);
  assert.doesNotMatch(setup,/ConvertFrom-SecureString[^\r\n]*-AsPlainText/);
  assert.doesNotMatch(setup,/Write-Host \$candidate/);
});

test("per-user Windows task starts only on sign-in, without passwords or pairing token arguments",()=>{
  assert.match(setup,/New-ScheduledTaskTrigger -AtLogOn -User \$windowsUser/);
  assert.match(setup,/New-ScheduledTaskPrincipal -UserId \$windowsUser -LogonType Interactive -RunLevel Limited/);
  assert.match(setup,/New-ScheduledTaskSettingsSet @settingsParams/);
  assert.match(setup,/ExecutionTimeLimit = \[TimeSpan\]::Zero/);
  assert.match(setup,/MultipleInstances = 'IgnoreNew'/);
  assert.match(setup,/Start-ScheduledTask -TaskName \$taskName/);
  assert.match(setup,/Register-ScheduledTask @registration/);
  assert.match(setup,/ExecutionPolicy Bypass -WindowStyle Hidden/);
  assert.match(setup,/& \$node \$agent "--auto-start"/);
  assert.match(setup,/taskName = 'QR-To-Print-Agent-' \+ \$userSid\.Value/);
  assert.match(setup,/[\r\n]\s*Force = \$true/);
  assert.doesNotMatch(setup,/schtasks\.exe \/Create/);
  assert.doesNotMatch(setup,/LogonType Password|RunLevel Highest/);
  assert.doesNotMatch(setup,/-Argument[^\r\n]*qrpa_/);
});

test("one-click installer/uninstaller are local only and clean up encrypted key plus task",()=>{
  assert.match(installCmd,/setup-windows-agent-autostart\.ps1"/);
  assert.match(uninstallCmd,/setup-windows-agent-autostart\.ps1" -Uninstall/);
  assert.match(setup,/if \(\$Uninstall\)/);
  assert.match(setup,/Stop-ScheduledTask -TaskName \$taskName/);
  assert.match(setup,/Unregister-ScheduledTask -TaskName \$taskName/);
  assert.match(setup,/Remove-Item -LiteralPath \$keyFile -Force/);
  assert.match(setup,/Remove-Item -LiteralPath \$installDir -Recurse -Force/);
  assert.match(setup,/Also click Revoke connection in Shop Dashboard/);
  assert.doesNotMatch(installCmd,/qrpa_[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(uninstallCmd,/qrpa_[A-Za-z0-9_-]{43}/);
});

test("shop dashboard offers real ZIP and correct login-trigger instructions",()=>{
  assert.match(dashboard,/Install-QR-To-Print-Agent\.cmd/);
  assert.match(dashboard,/Uninstall-QR-To-Print-Agent\.cmd/);
  assert.match(dashboard,/WINDOWS_AGENT_AUTOSTART\.md/);
  assert.match(dashboard,/github\.com\/mahadeventerprises24102024-ship-it\/qr-to-print-new\/archive\/refs\/heads\/main\.zip/);
  assert.match(dashboard,/बिना Windows Login किए नहीं चलेगा/);
  assert.match(dashboard,/Agent केवल Printer Discovery/);
  new vm.Script(dashboard.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test("auto-start changes no API authorization or agent printing safety flags",()=>{
  const api=file("printer-agent-api.js");
  assert.match(api,/printingEnabled: false/);
  assert.match(api,/\/api\/agent\/heartbeat/);
  assert.match(api,/authorization/);
  assert.match(api,/token_hash/);
  assert.match(server,/req\.method === "POST" && req\.path === "\/agent\/heartbeat"/);
  assert.doesNotMatch(server,/print-customer/);
  assert.match(file("WINDOWS_AGENT_AUTOSTART.md"),/does not run before the Windows login screen/);
});
