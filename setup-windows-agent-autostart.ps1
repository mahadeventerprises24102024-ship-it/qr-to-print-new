# QR-To-Print - per-user Windows Agent auto-start setup
# Windows 10/11 PowerShell 5.1+, Node.js 20+
# Run as normal Windows user, not as Administrator.
[CmdletBinding()]
param([switch]$Uninstall)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only.' }
if (-not $env:LOCALAPPDATA) { throw 'Windows LocalAppData is missing.' }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$windowsUser = $identity.Name
$userSid = $identity.User
$taskName = 'QR-To-Print-Agent-' + $userSid.Value
$installDir = Join-Path $env:LOCALAPPDATA 'QR-To-Print-Agent'
$installedAgent = Join-Path $installDir 'windows-print-agent.js'
$launcherPath = Join-Path $installDir 'start-agent.ps1'
$keyFile = Join-Path $installDir 'pairing-key.dpapi'

# DPAPI must use the same Windows account as the scheduled task.
$principalCheck = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run from your normal unelevated Windows account, NOT Run as administrator.'
}

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $keyFile) {
    Remove-Item -LiteralPath $keyFile -Force
  }
  if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
  }
  Write-Host 'QR-To-Print auto-start task and encrypted local pairing key removed.'
  Write-Host 'Also click Revoke connection in Shop Dashboard to invalidate the server pairing key.'
  exit 0
}

$sourceAgent = Join-Path $PSScriptRoot 'windows-print-agent.js'
if (-not (Test-Path -LiteralPath $sourceAgent -PathType Leaf)) {
  throw 'windows-print-agent.js must be next to this setup script in the GitHub ZIP.'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or -not $nodeCommand.Source) {
  throw 'Node.js 20+ is needed. Install Node.js, then run setup again.'
}
$nodeExe = $nodeCommand.Source
$nodeVersionText = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v([0-9]+)\.') {
  throw 'Cannot verify Node.js version.'
}
if ([int]$Matches[1] -lt 20) { throw 'Please install Node.js version 20 or newer.' }

Write-Host ''
Write-Host 'QR-To-Print: Connect automatically after Windows sign-in'
Write-Host 'Only printer discovery and heartbeat start automatically.'
Write-Host 'No automatic printing or customer file downloads.'
Write-Host 'First generate and COPY a new pairing key in Shop Dashboard > Printers.'
Write-Host 'Your pairing key will never be printed to logs or task arguments.'
Write-Host ''

$clipboardValue = $null
try { $clipboardValue = Get-Clipboard -Raw -ErrorAction Stop }
catch { $clipboardValue = $null }
$secureKey = $null
if ($clipboardValue -is [string] -and
    $clipboardValue.Trim() -cmatch '^qrpa_[A-Za-z0-9_-]{43}$') {
  $secureKey = ConvertTo-SecureString -String $clipboardValue.Trim() -AsPlainText -Force
  Write-Host 'Valid-format shop pairing key read from the clipboard.'
} else {
  Write-Host 'Clipboard has no valid pairing key. Paste your new key below (hidden).'
  $secureKey = Read-Host 'Shop pairing key' -AsSecureString
}
$clipboardValue = $null

# Format validation: never echo the token. Zero the unmanaged BSTR immediately.
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $candidate = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ($candidate -cnotmatch '^qrpa_[A-Za-z0-9_-]{43}$') {
    throw 'Invalid key: generate/copy a NEW pairing key from your own shop dashboard.'
  }
} finally {
  $candidate = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if (-not (Test-Path -LiteralPath $installDir)) {
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Restrict the directory to current user, SYSTEM and local Administrators.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sidText in @($userSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($sidText)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
}
$acl.SetOwner($userSid)
Set-Acl -LiteralPath $installDir -AclObject $acl -ErrorAction Stop

# No explicit encryption key: Windows DPAPI protects this secret to this user.
# No plaintext keys in .cmd/.ps1, process command lines, registry or GitHub.
$encrypted = ConvertFrom-SecureString -SecureString $secureKey
$tempKey = Join-Path $installDir 'pairing-key.pending'
try {
  [System.IO.File]::WriteAllText($tempKey, $encrypted, [System.Text.Encoding]::ASCII)
  Move-Item -LiteralPath $tempKey -Destination $keyFile -Force
} finally {
  if (Test-Path -LiteralPath $tempKey) {
    Remove-Item -LiteralPath $tempKey -Force -ErrorAction SilentlyContinue
  }
  $encrypted = $null
}

Copy-Item -LiteralPath $sourceAgent -Destination $installedAgent -Force

# The task is hidden and always runs under the same interactive Windows user.
# Launcher contains no secrets; the Node agent reads the DPAPI-encrypted file.
$launcher = @'
$ErrorActionPreference = "Stop"
$agent = Join-Path $PSScriptRoot "windows-print-agent.js"
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node $agent "--auto-start"
'@
[System.IO.File]::WriteAllText($launcherPath, $launcher, [System.Text.Encoding]::UTF8)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $windowsUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $windowsUser -LogonType Interactive -RunLevel Limited
$settingsParams = @{
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
  ExecutionTimeLimit = [TimeSpan]::Zero
  RestartCount = 3
  RestartInterval = (New-TimeSpan -Minutes 1)
  MultipleInstances = 'IgnoreNew'
  StartWhenAvailable = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsParams
$powerShellExe = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory $installDir
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$registration = @{
  TaskName = $taskName
  Action = $action
  Trigger = $trigger
  Principal = $taskPrincipal
  Settings = $settings
  Description = 'QR-To-Print printer discovery heartbeat (no automatic customer printing)'
  Force = $true
  ErrorAction = 'Stop'
}
Register-ScheduledTask @registration | Out-Null
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

Write-Host ''
Write-Host 'SUCCESS: Agent starts now, and again after this Windows account signs in.'
Write-Host 'After network outages it retries automatically.'
Write-Host 'Shop Dashboard > Printers > Refresh status should show Online.'
Write-Host 'Customer document auto-printing remains OFF.'
Write-Host 'Use Uninstall-QR-To-Print-Agent.cmd to remove local setup.'
Write-Host ''
