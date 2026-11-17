<#
  Dexterity Connect Hub: installs, repairs, upgrades or removes the hub's Windows service.

  One script for both ways of installing the hub, so the logic lives in one place:
    - DexterityConnectHub-Setup.exe (the installer) runs it from the install folder;
    - Install-Hub.cmd / Uninstall-Hub.cmd in the hub zip run it from the zip's folder.

    Install-Hub.ps1                         install or repair the hub in this script's folder
    Install-Hub.ps1 -DataDir E:\HubData     a new install with its data there (an existing hub's
                                            data always stays where it is)
    Install-Hub.ps1 -NoKeepAwake            leave the PC's sleep settings alone
    Install-Hub.ps1 -CheckOnly              only check this PC (Windows, disk space, ports)
    Install-Hub.ps1 -StopOnly               only stop the hub service (before files are replaced)
    Install-Hub.ps1 -Uninstall [-RemoveData]  remove the service and firewall rules; the data is
                                            kept unless -RemoveData

  Running it again is safe: it repairs and upgrades without a second service, without duplicate
  firewall rules and without touching the data. Everything it does goes to
  %ProgramData%\Dexterity Connect Hub\setup.log.

  Exit codes: 0 done, 1 failed, 2 refused (this PC does not meet a requirement; nothing changed).
  The last message is also written to -ResultFile when given (the installer shows it).
  Keep this file ASCII: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallDir = '',
  [string] $DataDir = '',
  [string] $Version = '',
  [switch] $NoKeepAwake,
  [switch] $CheckOnly,
  [switch] $StopOnly,
  [switch] $Uninstall,
  [switch] $RemoveData,
  [int] $HealthTimeoutSec = 150,
  [string] $ResultFile = '',
  [string] $LogFile = ''
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$ServiceId = 'DexterityConnectHub'
$ServiceName = 'Dexterity Connect Hub'
$HubPort = 47900
$DiscoveryPort = 47901
$RoomPorts = '47910-47999'
$LocationFile = 'hub-data-location.txt'
# remembered across an uninstall that keeps the data, so installing again finds the same hub
$RegKey = 'HKLM:\SOFTWARE\Dexterity Connect Hub'
$WrapperName = 'DexterityConnectHubService.exe'
$HubExeName = 'DexterityConnectHub.exe'
$WorkerName = 'mediasoup-worker.exe'
$ProgramDataDir = Join-Path $env:ProgramData $ServiceName
$Rules = @('Dexterity Connect Hub (connections)', 'Dexterity Connect Hub (discovery)', 'Dexterity Connect Hub (large Rooms)')

if (-not $InstallDir) { $InstallDir = $PSScriptRoot }
# "D:\Hub\." (from Install-Hub.cmd) becomes "D:\Hub": firewall rules must name the exact program path
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($DataDir -and -not $DataDir.StartsWith('\\')) {
  $DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
  if ($DataDir -match '^[A-Za-z]:$') { $DataDir += '\Dexterity Connect Hub Data' }   # never a whole drive
}
if (-not $LogFile) { $LogFile = Join-Path $ProgramDataDir 'setup.log' }

# ------------------------------------------------------------------ logging
function Protect-Folder([string] $dir) {
  # only SYSTEM and Administrators: the data folder holds the hub's private key and every message
  try {
    $code = Invoke-Native 'icacls.exe' @($dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    if ($code -ne 0) { Log "Warning: could not limit who can open $dir." 'Yellow' }
  } catch { Log "Warning: could not limit who can open $dir ($($_.Exception.Message))." 'Yellow' }
}

function Initialize-Log {
  $dir = Split-Path -Parent $LogFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if ((Normalize $dir) -eq (Normalize $ProgramDataDir)) { Protect-Folder $dir }
  }
}

function Log([string] $text, [string] $color = '') {
  $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $text
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

function Finish([int] $code, [string] $message) {
  $color = if ($code -eq 0) { 'Green' } else { 'Red' }
  Log '' ; Log $message $color
  if ($code -ne 0) { Log "Setup log: $LogFile" }
  if ($ResultFile) {
    $text = $message
    if ($code -ne 0) { $text += "`r`n`r`nSetup log: $LogFile" }
    # UTF-16 without a byte-order mark: the installer reads it with FileReadUTF16LE
    try { [IO.File]::WriteAllText($ResultFile, $text, (New-Object Text.UnicodeEncoding $false, $false)) } catch { }
  }
  Log "-- finished with exit code $code"
  exit $code
}

# Runs a program, logs what it printed, and returns its exit code. Native programs that write to
# stderr must not stop the script, so errors are not turned into exceptions here.
function Invoke-Native([string] $exe, [string[]] $argv) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = @(& $exe @argv 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
  $code = $LASTEXITCODE
  Log ("  > {0} {1}  (exit {2})" -f (Split-Path -Leaf $exe), ($argv -join ' '), $code)
  foreach ($l in $out) { if ($l.Trim()) { Log "    $l" } }
  return $code
}

function Normalize([string] $p) {
  if (-not $p) { return '' }
  try { $p = [IO.Path]::GetFullPath($p) } catch { }
  return $p.TrimEnd('\').ToLowerInvariant()
}

# ------------------------------------------------------------------ the existing service
function Get-HubService { return Get-Service -Name $ServiceId -ErrorAction SilentlyContinue }

# The program the service runs (WinSW's DexterityConnectHubService.exe), from the service's own
# settings, so an install from the old zip in another folder is found and upgraded in place.
function Get-ServiceWrapperPath {
  $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceId"
  if (-not (Test-Path $key)) { return $null }
  $image = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).ImagePath
  if (-not $image) { return $null }
  $image = [Environment]::ExpandEnvironmentVariables([string] $image)
  if ($image -match '^\s*"([^"]+)"') { return $Matches[1] }
  if ($image -match '^\s*(.+?\.exe)') { return $Matches[1] }
  return $image.Trim()
}

function Read-LocationFile([string] $dir) {
  if (-not $dir) { return $null }
  $file = Join-Path $dir $LocationFile
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  foreach ($line in @(Get-Content -LiteralPath $file)) {
    $l = ([string] $line).Trim().TrimStart([char] 0xFEFF)
    if ($l -and -not $l.StartsWith('#') -and [IO.Path]::IsPathRooted($l)) { return $l }
  }
  return $null
}

function Read-RegistryDataDir {
  try { return [string] (Get-ItemProperty -Path $RegKey -Name DataDir -ErrorAction Stop).DataDir } catch { return $null }
}

function Read-ServiceXmlDataDir([string] $dir) {
  if (-not $dir) { return $null }
  $file = Join-Path $dir 'DexterityConnectHubService.xml'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try {
    $doc = New-Object System.Xml.XmlDocument
    $doc.Load($file)
    $node = $doc.SelectSingleNode("/service/env[@name='DEXCONNECT_DATA_DIR']")
    if (-not $node) { return $null }
    $value = $node.GetAttribute('value').Replace('%BASE%', $dir)
    return [Environment]::ExpandEnvironmentVariables($value)
  } catch { return $null }
}

# Where the hub's data is. Data that already exists always wins, so an upgrade or repair never
# starts a second, empty hub beside the real one.
function Resolve-DataDir([string] $installDir, [string] $oldDir, [string] $requested) {
  $found = @()
  $found += Read-LocationFile $installDir
  $found += Read-RegistryDataDir
  if ($oldDir) { $found += Read-LocationFile $oldDir; $found += Read-ServiceXmlDataDir $oldDir }
  $found += Join-Path $installDir 'hub-data'
  foreach ($d in $found) {
    if ($d -and (Test-Path -LiteralPath (Join-Path $d 'hub.db'))) {
      if ($requested -and (Normalize $requested) -ne (Normalize $d)) {
        Log "Note: the hub's data is already in $d, so it stays there (not $requested). To move it, use a backup and --restore (docs/BACKUP.md)." 'Yellow'
      }
      return $d
    }
  }
  if ($requested) { return $requested }
  foreach ($d in $found) { if ($d -and (Test-Path -LiteralPath $d)) { return $d } }
  return (Join-Path $installDir 'hub-data')
}

# ------------------------------------------------------------------ checks
function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Finish 2 'Run this as an administrator (right-click, Run as administrator).'
  }
}

function Assert-Windows {
  $v = [Environment]::OSVersion.Version
  $is64 = [Environment]::Is64BitOperatingSystem
  Log ("Windows {0} ({1}-bit), PowerShell {2} ({3}-bit)" -f $v, $(if ($is64) { 64 } else { 32 }), $PSVersionTable.PSVersion, $(if ([Environment]::Is64BitProcess) { 64 } else { 32 }))
  if ($v.Major -lt 10 -or -not $is64) {
    Finish 2 'The office hub needs 64-bit Windows 10 or Windows 11. This PC has an older or 32-bit Windows: use another PC for the hub.'
  }
}

function Test-Disk([string] $installDir, [string] $dataDir) {
  if ($dataDir.StartsWith('\\')) {
    Finish 2 "The hub's data must be on a disk of this PC, not on a network share ($dataDir). Choose a local folder; put the backups on the share instead."
  }
  foreach ($check in @(@{ Path = $installDir; Need = 0.3; Warn = 0.3; What = 'the program' }, @{ Path = $dataDir; Need = 1; Warn = 10; What = "the hub's data" })) {
    try {
      $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($check.Path))
      if (-not $drive.IsReady) { Finish 2 ("Drive {0} (for {1}) is not ready." -f $drive.Name, $check.What) }
      $freeGb = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
      Log ("Free space on {0} ({1}): {2} GB" -f $drive.Name, $check.What, $freeGb)
      if ($freeGb -lt $check.Need) { Finish 2 ("Drive {0} has only {1} GB free; {2} needs at least {3} GB. Free some space and run setup again." -f $drive.Name, $freeGb, $check.What, $check.Need) }
      if ($freeGb -lt $check.Warn) { Log ("Warning: drive {0} has {1} GB free. Shared files and recordings grow; 10 GB or more is better for {2}." -f $drive.Name, $freeGb, $check.What) 'Yellow' }
    } catch {
      Finish 2 ("The folder {0} is not on a drive of this PC ({1})." -f $check.Path, $_.Exception.Message)
    }
  }
}

# What holds the hub's ports, as text, or nothing when they are free. Processes in $ownDirs (the
# hub itself, about to be stopped and replaced) are allowed when $allowOwn is set.
function Get-PortConflicts([string[]] $ownDirs, [bool] $allowOwn) {
  $users = @()
  try { foreach ($c in @(Get-NetTCPConnection -LocalPort $HubPort -State Listen -ErrorAction SilentlyContinue)) { $users += @{ Port = "TCP $HubPort"; Id = [int] $c.OwningProcess } } } catch { }
  try { foreach ($c in @(Get-NetUDPEndpoint -LocalPort $DiscoveryPort -ErrorAction SilentlyContinue)) { $users += @{ Port = "UDP $DiscoveryPort"; Id = [int] $c.OwningProcess } } } catch { }
  $problems = @()
  foreach ($u in $users) {
    $p = Get-Process -Id $u.Id -ErrorAction SilentlyContinue
    $name = if ($p) { $p.ProcessName } else { "process $($u.Id)" }
    $path = $null
    if ($p) { try { $path = $p.Path } catch { } }
    $own = $false
    if ($name -eq 'DexterityConnectHub') {
      if (-not $path) { $own = $true }
      else { foreach ($d in $ownDirs) { if ($d -and (Normalize (Split-Path -Parent $path)) -eq (Normalize $d)) { $own = $true } } }
    }
    if ($own -and $allowOwn) { continue }
    $where = if ($path) { " ($path)" } else { '' }
    if ($name -eq 'DexterityConnectHub') {
      $problems += "$($u.Port) is used by another copy of the hub$where. Close it (Task Manager, or remove its service) and run setup again."
    } else {
      $problems += "$($u.Port) is used by $name$where. The hub needs this port: stop or reconfigure that program, then run setup again."
    }
  }
  return ($problems | Select-Object -Unique) -join "`r`n"
}

# ------------------------------------------------------------------ service control
function Stop-Hub([string[]] $dirs) {
  $svc = Get-HubService
  if ($svc -and $svc.Status -ne 'Stopped') {
    Log 'Stopping the hub service...'
    $null = Invoke-Native 'sc.exe' @('stop', $ServiceId)
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
      $svc = Get-HubService
      if (-not $svc -or $svc.Status -eq 'Stopped') { break }
      Start-Sleep -Milliseconds 500
    }
    if ($svc -and $svc.Status -ne 'Stopped') { Log 'The service did not stop within 60 seconds; its programs are closed instead.' 'Yellow' }
  }
  # programs still running from the folders being replaced: the hub, its relay workers, WinSW
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $left = @(Get-Process -Name 'DexterityConnectHub', 'mediasoup-worker', 'DexterityConnectHubService' -ErrorAction SilentlyContinue | Where-Object {
        $path = $null; try { $path = $_.Path } catch { }
        $path -and (@($dirs | Where-Object { $_ -and (Normalize (Split-Path -Parent $path)) -eq (Normalize $_) }).Count -gt 0)
      })
    if (-not $left.Count) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  foreach ($p in $left) {
    Log "Closing $($p.ProcessName) (process $($p.Id))"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

function Wait-ServiceRunning([int] $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $svc = Get-HubService
    if ($svc -and $svc.Status -eq 'Running') { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# GET https://127.0.0.1:47900/health. The hub's certificate is its own (the apps pin it by
# fingerprint), so only that the hub answers with its health JSON is checked here, not the
# certificate, and only for this one local request.
function Get-Health {
  if (-not ('DexHubHealth' -as [type])) {
    # (HttpWebRequest is marked obsolete in PowerShell 7's .NET; it works in both)
    Add-Type -TypeDefinition @'
#pragma warning disable
using System;
using System.IO;
using System.Net;
public static class DexHubHealth {
  public static string Get(string url, int timeoutMs) {
    var req = (HttpWebRequest)WebRequest.Create(url);
    req.Timeout = timeoutMs;
    req.ReadWriteTimeout = timeoutMs;
    req.Proxy = null;
    req.ServerCertificateValidationCallback = delegate { return true; };
    using (var res = (HttpWebResponse)req.GetResponse())
    using (var reader = new StreamReader(res.GetResponseStream())) { return reader.ReadToEnd(); }
  }
}
'@
  }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]'Tls13' } catch { }
  try {
    $body = [DexHubHealth]::Get("https://127.0.0.1:$HubPort/health", 5000)
    $json = $body | ConvertFrom-Json
    if ($json.ok -eq $true) { return $json }
  } catch { $script:LastHealthError = $_.Exception.InnerException; if (-not $script:LastHealthError) { $script:LastHealthError = $_.Exception } }
  return $null
}

function Write-HubLogTail([string] $installDir) {
  foreach ($name in @('DexterityConnectHubService.err.log', 'DexterityConnectHubService.out.log', 'DexterityConnectHubService.wrapper.log')) {
    $file = Join-Path (Join-Path $installDir 'logs') $name
    if (Test-Path -LiteralPath $file) {
      Log "Last lines of $file :"
      foreach ($l in @(Get-Content -LiteralPath $file -Tail 15 -ErrorAction SilentlyContinue)) { Log "    $l" }
    }
  }
}

# ------------------------------------------------------------------ firewall
function Remove-HubFirewallRules {
  foreach ($name in $Rules) {
    $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    if ($existing.Count) { $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue; Log "Removed firewall rule: $name ($($existing.Count))" }
  }
}

# The same rules Install-Hub.cmd has always made: inbound, any profile, for the hub's own programs
# only. Removed by name first, so running setup again never doubles them.
function Set-HubFirewallRules([string] $hubExe, [string] $worker) {
  Remove-HubFirewallRules
  $want = @(
    @{ Name = $Rules[0]; Protocol = 'TCP'; Port = "$HubPort"; Program = $hubExe },
    @{ Name = $Rules[1]; Protocol = 'UDP'; Port = "$DiscoveryPort"; Program = $hubExe }
  )
  if (Test-Path -LiteralPath $worker) {
    $want += @{ Name = $Rules[2]; Protocol = 'UDP'; Port = $RoomPorts; Program = $worker }
    $want += @{ Name = $Rules[2]; Protocol = 'TCP'; Port = $RoomPorts; Program = $worker }
  }
  foreach ($r in $want) {
    New-NetFirewallRule -DisplayName $r.Name -Group $ServiceName -Direction Inbound -Action Allow -Protocol $r.Protocol `
      -LocalPort $r.Port -Program $r.Program -Profile Any -Enabled True | Out-Null
    Log ("Firewall rule: {0}, {1} {2}, {3}" -f $r.Name, $r.Protocol, $r.Port, $r.Program)
  }
}

# ------------------------------------------------------------------ main
# anything unexpected still ends with a message and an exit code the installer understands
trap {
  Log ("Error: {0}" -f $_.Exception.Message) 'Red'
  Finish 1 "Setup did not finish: $($_.Exception.Message)"
}
Initialize-Log
$mode = if ($Uninstall) { 'uninstall' } elseif ($CheckOnly) { 'check' } elseif ($StopOnly) { 'stop' } else { 'install' }
Log "== Dexterity Connect Hub setup ($mode)$(if ($Version) { " $Version" })"
Log "Program folder: $InstallDir"

Assert-Admin
$oldWrapper = Get-ServiceWrapperPath
$oldDir = if ($oldWrapper) { Split-Path -Parent $oldWrapper } else { $null }
$svc = Get-HubService
if ($svc) { Log ("Existing service: {0}, {1}, runs {2}" -f $svc.Status, $svc.StartType, $oldWrapper) } else { Log 'No hub service yet.' }
$wrapper = Join-Path $InstallDir $WrapperName
$hubExe = Join-Path $InstallDir $HubExeName
$worker = Join-Path $InstallDir $WorkerName
$dirs = @($InstallDir, $oldDir) | Where-Object { $_ }

if ($Uninstall) {
  $removed = $false
  if ($svc) {
    if ($oldDir -and (Normalize $oldDir) -ne (Normalize $InstallDir)) {
      Log "The hub service runs from $oldDir, not from this folder, so it is left as it is." 'Yellow'
    } else {
      Stop-Hub $dirs
      $null = Invoke-Native 'sc.exe' @('delete', $ServiceId)
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-HubService) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      if (Get-HubService) { Log 'Windows removes the service once the Services window is closed (or after a restart).' 'Yellow' }
      $removed = $true
    }
  } else { $removed = $true }
  if ($removed) { Remove-HubFirewallRules }
  $data = Resolve-DataDir $InstallDir $oldDir ''
  if ($RemoveData -and -not $removed) {
    Finish 1 "The hub's data was not deleted: the hub service still runs from $oldDir and uses it."
  }
  if ($RemoveData) {
    $full = Normalize $data
    $isRoot = $full.Length -le 3
    $looksRight = (Test-Path -LiteralPath (Join-Path $data 'hub.db')) -or ((Split-Path -Leaf $data) -eq 'hub-data') -or
      ((Test-Path -LiteralPath $data) -and -not @(Get-ChildItem -LiteralPath $data -Force -ErrorAction SilentlyContinue).Count)
    if ($isRoot -or $full -eq (Normalize $InstallDir) -or -not $looksRight) {
      Log "The data folder $data does not look like the hub's data, so it was not deleted." 'Yellow'
    } elseif (Test-Path -LiteralPath $data) {
      Remove-Item -LiteralPath $data -Recurse -Force
      Log "Deleted the hub's data: $data"
    }
    $logs = Join-Path $InstallDir 'logs'
    if (Test-Path -LiteralPath $logs) { Remove-Item -LiteralPath $logs -Recurse -Force -ErrorAction SilentlyContinue; Log "Deleted the hub's logs: $logs" }
    if (-not (Test-Path -LiteralPath $data)) { Remove-Item -Path $RegKey -Recurse -Force -ErrorAction SilentlyContinue }
    Finish 0 'The hub is removed, with its data.'
  }
  Log 'Power settings are left as they are.'
  Finish 0 "The hub is removed. Its data is kept in $data"
}

Assert-Windows
$data = Resolve-DataDir $InstallDir $oldDir $DataDir
Log "Data folder: $data"
Test-Disk $InstallDir $data

if ($CheckOnly) {
  $conflicts = Get-PortConflicts $dirs $true
  if ($conflicts) { Finish 2 $conflicts }
  Finish 0 'This PC is ready for the hub.'
}
if ($StopOnly) {
  Stop-Hub $dirs
  Finish 0 'The hub is stopped.'
}

foreach ($f in @($hubExe, $wrapper, (Join-Path $InstallDir 'DexterityConnectHubService.xml'))) {
  if (-not (Test-Path -LiteralPath $f)) { Finish 1 "$f is missing. Extract the whole hub zip (or run the setup again) and try again." }
}

try {
  # 1. stop what runs now, and make sure nothing else holds the ports
  Stop-Hub $dirs
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $conflicts = Get-PortConflicts @() $false
    if (-not $conflicts) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($conflicts) { Finish 2 $conflicts }

  # 2. the data folder, and where the program finds it when run by hand (--restore)
  if (-not (Test-Path -LiteralPath $data)) {
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    Protect-Folder $data
    Log "Created the data folder (only SYSTEM and Administrators can open it): $data"
  } else {
    Log 'The data folder exists and is left untouched.'
  }
  Set-Content -LiteralPath (Join-Path $InstallDir $LocationFile) -Encoding UTF8 -Value @(
    '# Where Dexterity Connect Hub keeps its data. Written by Install-Hub.ps1; the service and',
    '# "DexterityConnectHub.exe --restore" both use it. Move data with a backup and --restore.',
    $data)
  if (-not (Test-Path $RegKey)) { New-Item -Path $RegKey -Force | Out-Null }
  Set-ItemProperty -Path $RegKey -Name DataDir -Value $data
  Set-ItemProperty -Path $RegKey -Name InstallDir -Value $InstallDir

  # 3. the service definition WinSW reads at every start
  $xmlPath = Join-Path $InstallDir 'DexterityConnectHubService.xml'
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.Load($xmlPath)
  $envNode = $doc.SelectSingleNode("/service/env[@name='DEXCONNECT_DATA_DIR']")
  if (-not $envNode) {
    $envNode = $doc.CreateElement('env'); $envNode.SetAttribute('name', 'DEXCONNECT_DATA_DIR')
    $null = $doc.DocumentElement.AppendChild($envNode)
  }
  $envNode.SetAttribute('value', $data)
  $doc.Save($xmlPath)
  Log "Service definition: $xmlPath"

  # 4. the service: installed once, then only updated, so there is never a second one
  $svc = Get-HubService
  if (-not $svc) {
    Log 'Installing the hub service...'
    if ((Invoke-Native $wrapper @('install')) -ne 0 -or -not (Get-HubService)) { Finish 1 'Windows did not accept the hub service (see the lines above).' }
  } elseif ((Normalize $oldWrapper) -ne (Normalize $wrapper)) {
    Log "Pointing the existing service at $wrapper (it ran $oldWrapper)"
    $cim = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'"
    $r = Invoke-CimMethod -InputObject $cim -MethodName Change -Arguments @{ PathName = "`"$wrapper`"" }
    if ($r.ReturnValue -ne 0) { Finish 1 "Windows did not let the service move to $wrapper (error $($r.ReturnValue))." }
    Log "The programs in $oldDir are no longer used (delete them later if you like). The data stays in $data." 'Yellow'
  } else {
    Log 'Updating the existing hub service.'
  }
  # delayed automatic start (the PC finishes starting first), and restart after a failure three
  # times (5 s, 20 s, 60 s; the count resets after an hour). The account is left as it is: Local
  # System for a new install, and whatever the office chose for an existing one.
  $null = Invoke-Native 'sc.exe' @('config', $ServiceId, 'start=', 'delayed-auto')
  $null = Invoke-Native 'sc.exe' @('failure', $ServiceId, 'reset=', '3600', 'actions=', 'restart/5000/restart/20000/restart/60000')
  $null = Invoke-Native 'sc.exe' @('failureflag', $ServiceId, '1')
  $null = Invoke-Native 'sc.exe' @('description', $ServiceId, 'Office hub for Dexterity Connect: people, messages, files and calls on the local network. Works without internet.')
  $account = (Get-CimInstance Win32_Service -Filter "Name='$ServiceId'").StartName
  Log "The service runs as $account."

  # 5. Windows Firewall
  $firewallNote = ''
  try { Set-HubFirewallRules $hubExe $worker } catch {
    $firewallNote = "Windows Firewall rules could not be set ($($_.Exception.Message)). Other PCs may not reach the hub: allow TCP $HubPort and UDP $DiscoveryPort for $hubExe."
    Log $firewallNote 'Yellow'
  }

  # 6. a server PC must not sleep while plugged in
  if ($NoKeepAwake) {
    Log 'Sleep settings left as they are (-NoKeepAwake).'
  } else {
    $a = Invoke-Native 'powercfg.exe' @('/change', 'standby-timeout-ac', '0')
    $b = Invoke-Native 'powercfg.exe' @('/change', 'hibernate-timeout-ac', '0')
    if ($a -eq 0 -and $b -eq 0) { Log 'This PC no longer sleeps or hibernates while plugged in (the screen may still turn off).' }
    else { Log 'Could not change the sleep settings; set "When plugged in, put my device to sleep after: Never" in Settings > System > Power.' 'Yellow' }
  }

  # 7. start, and wait until the hub answers
  Log 'Starting the hub...'
  $null = Invoke-Native 'sc.exe' @('start', $ServiceId)
  if (-not (Wait-ServiceRunning 60)) {
    Write-HubLogTail $InstallDir
    Finish 1 "The hub service did not start. The hub's own logs are in $(Join-Path $InstallDir 'logs')."
  }
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  $health = $null
  $script:LastHealthError = $null
  while ((Get-Date) -lt $deadline) {
    $health = Get-Health
    if ($health) { break }
    $svc = Get-HubService
    if (-not $svc -or $svc.Status -ne 'Running') { Start-Sleep -Seconds 2 } else { Start-Sleep -Seconds 1 }
  }
  if (-not $health) {
    if ($script:LastHealthError) { Log "Last answer from the hub: $($script:LastHealthError.Message)" }
    Write-HubLogTail $InstallDir
    Finish 1 "The hub was installed but did not answer at https://127.0.0.1:$HubPort/health within $HealthTimeoutSec seconds. The hub's own logs are in $(Join-Path $InstallDir 'logs')."
  }
} catch {
  Log ("Error: {0}" -f $_.Exception.Message) 'Red'
  Log ("  at {0}" -f $_.InvocationInfo.PositionMessage)
  Finish 1 "Setup did not finish: $($_.Exception.Message)"
}

$addresses = @()
try {
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
} catch { }
$hubName = ''
try { $hubName = [string] $health.hub.name } catch { }
Log ("Health: ok. Hub '{0}', fingerprint {1}, {2} people." -f $hubName, $health.fingerprint, $health.users)
$message = "Dexterity Connect Hub is installed and running. It starts with Windows, before anyone signs in, and restarts itself if it stops."
if ($addresses.Count) { $message += "`r`nThis PC's address: $($addresses -join ', ') (port $HubPort)." }
$message += "`r`nData: $data"
if ($firewallNote) { $message += "`r`n`r`n$firewallNote" }
$message += "`r`n`r`nNext: install Dexterity Connect on your own PC and open it. The first person to join becomes the owner."
Finish 0 $message
