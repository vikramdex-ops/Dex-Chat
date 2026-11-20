<#
  Updates the Windows app from one setup to another on a clean PC, the way the in-app updater does:
  the old version installed and running, then the new setup with /S --updated --force-run. Then the
  same with the app closed. Any dialog the setup shows (a silent update must show none) is recorded
  with its text and a screenshot. Used by .github/workflows/app-update-test.yml (and build.yml).
#>
param([Parameter(Mandatory)] [string] $Old, [Parameter(Mandatory)] [string] $New)
$ErrorActionPreference = 'Stop'
$Logs = Join-Path (Get-Location) 'update-test-logs'
New-Item -ItemType Directory -Force $Logs | Out-Null
$failures = 0
function Check([bool] $ok, [string] $what) {
  if ($ok) { Write-Host "  ok    $what" } else { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:failures++ }
}
function Step([string] $s) { Write-Host ''; Write-Host "== $s" }

function Get-App {
  foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
    foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $k.PSPath
      if ($p.DisplayName -like 'Dexterity Connect*' -and $p.DisplayName -notlike '*Hub*') {
        # the setup records no InstallLocation: the folder is the uninstaller's
        $dir = $p.InstallLocation
        if (-not $dir -and $p.UninstallString -match '^"?([^"]+\\)[^"\\]+\.exe') { $dir = $Matches[1].TrimEnd('\') }
        return [pscustomobject]@{ Key = $k.PSPath; Version = $p.DisplayVersion; Dir = $dir; Uninstall = $p.UninstallString; Quiet = $p.QuietUninstallString }
      }
    }
  }
  return $null
}
function Get-AppProcesses([string] $dir) {
  if (-not $dir) { return @() }
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
function Save-Screen([string] $name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Logs "$name.png")); $g.Dispose(); $bmp.Dispose()
}
# The text of every window a process shows (a MessageBox: its title, message and buttons).
function Get-WindowText([int] $processId) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), $processId
  $out = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $out += "[window] $($w.Current.Name)"
    foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name) { $out += "  $($e.Current.ControlType.ProgrammaticName): $($e.Current.Name)" }
    }
  }
  return $out
}

# Runs a setup and waits up to $seconds; a setup still open after that is showing something: record it.
function Invoke-Setup([string] $exe, [string] $arguments, [string] $label, [int] $seconds = 300) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Resolve-Path $exe).Path; $psi.Arguments = $arguments; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p.WaitForExit($seconds * 1000)) {
    Write-Host "  the setup is still open after $seconds s: it is showing something" -ForegroundColor Yellow
    Get-WindowText $p.Id | ForEach-Object { Write-Host "    $_" }
    foreach ($c in Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.Id)") {
      Write-Host "    child: $($c.Name) $($c.CommandLine)"
      Get-WindowText ([int] $c.ProcessId) | ForEach-Object { Write-Host "      $_" }
    }
    Save-Screen "$label-stuck"
    & taskkill /f /t /pid $p.Id | Out-Null
    return -1
  }
  return $p.ExitCode
}

function Start-App([string] $dir) {
  $exe = Get-ChildItem $dir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  Start-Process $exe.FullName
  Start-Sleep -Seconds 25
  $procs = Get-AppProcesses $dir
  Write-Host "  running: $($procs.Count) process(es) from the install folder"
  $procs | ForEach-Object { Write-Host "    $($_.Id) $($_.ProcessName) $($_.Path)" }
  Save-Screen 'app-running'
  return $procs.Count
}

function Remove-App {
  $a = Get-App
  if (-not $a) { return }
  Get-AppProcesses $a.Dir | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $u = Join-Path $a.Dir 'Uninstall Dexterity Connect.exe'
  if (Test-Path $u) { [void](Invoke-Setup $u "/S _?=$($a.Dir)" 'uninstall' 120) }
  Remove-Item -Recurse -Force $a.Dir -ErrorAction SilentlyContinue
  Remove-Item $a.Key -Recurse -Force -ErrorAction SilentlyContinue
}

$newVersion = ([System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path $New).Path)).ProductVersion
Write-Host "new setup: $newVersion"

foreach ($running in $true, $false) {
  $label = if ($running) { 'running' } else { 'closed' }
  Step "Install the old version, then update with the app $label"
  Remove-App
  $code = Invoke-Setup $Old '/S' "install-old-$label"
  Check ($code -eq 0) "old setup exit code 0 (got $code)"
  $a = Get-App
  Check ($null -ne $a) "installed: $($a.Version) in $($a.Dir)"
  if (-not $a) { continue }
  if ($running) { Check ((Start-App $a.Dir) -gt 0) 'the app is running' }
  # what the in-app updater does (apps/desktop/src/main/updater.ts): start the setup, then quit the app
  $code = Invoke-Setup $New '/S --updated --force-run' "update-$label"
  Check ($code -eq 0) "update exit code 0 (got $code)"
  Start-Sleep -Seconds 5
  $b = Get-App
  Check ([bool] $b -and ($b.Version -eq $newVersion -or $b.Version -eq ($newVersion -replace '\.0$', ''))) "the new version is installed ($($b.Version))"
  Check ((Get-AppProcesses $b.Dir).Count -gt 0) 'the new version started (--force-run)'
  Save-Screen "after-$label"
}

# Updates run the way they do on an office PC: as the signed-in person WITHOUT administrator rights
# (runas /trustlevel:0x20000 strips them, as UAC does), over an install made for all users, and
# over an app running as administrator.
function Invoke-SetupAsUser([string] $exe, [string] $arguments, [string] $label, [int] $seconds = 240) {
  $full = (Resolve-Path $exe).Path
  $before = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object Id)
  & runas.exe /trustlevel:0x20000 "`"$full`" $arguments" | Out-Null
  Start-Sleep -Seconds 3
  $name = [IO.Path]::GetFileNameWithoutExtension($full)
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $p = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    if (-not $p.Count) { return 'finished' }
    Start-Sleep -Seconds 2
  }
  Write-Host "  the setup is still open after $seconds s: it is showing something" -ForegroundColor Yellow
  $script:dialog = ''
  foreach ($p in Get-Process -Name $name -ErrorAction SilentlyContinue) {
    $t = Get-WindowText $p.Id
    $script:dialog += ($t -join "`n")
    $t | ForEach-Object { Write-Host "    $_" }
    foreach ($c in Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.Id)") {
      Write-Host "    child: $($c.Name) $($c.CommandLine)"
      Get-WindowText ([int] $c.ProcessId) | ForEach-Object { Write-Host "      $_" }
    }
  }
  Save-Screen "$label-stuck"
  # answer the message as a person would (OK), so what the setup does next runs too
  foreach ($p in Get-Process -Name $name -ErrorAction SilentlyContinue) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), $p.Id
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      $ok = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), 'OK'))
      if ($ok) { ($ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); Write-Host '  clicked OK' }
    }
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count) { Start-Sleep -Seconds 1 }
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
  return 'stuck'
}

foreach ($case in 'all-users', 'all-users-admin', 'app-as-admin') {
  Step "Update: $case"
  Remove-App
  $flag = if ($case -like 'all-users*') { '/S /allusers' } else { '/S' }
  $code = Invoke-Setup $Old $flag "install-old-$case"
  Check ($code -eq 0) "old setup ($flag) exit code 0 (got $code)"
  $a = Get-App
  Check ($null -ne $a) "installed: $($a.Version) in $($a.Dir) ($($a.Key -replace '^.*::', ''))"
  if (-not $a) { continue }
  # the app as the person normally has it open (this test runs elevated, so for app-as-admin it is too)
  [void](Start-App $a.Dir)
  $script:dialog = ''
  if ($case -eq 'all-users-admin') {
    # the person clicked Yes when Windows asked: the setup runs with administrator rights
    $code = Invoke-Setup $New '/S --updated --force-run' "update-$case"
    $r = if ($code -eq 0) { 'finished' } else { "exit $code" }
  } else {
    $r = Invoke-SetupAsUser $New '/S --updated --force-run' "update-$case"
  }
  Start-Sleep -Seconds 5
  $b = Get-App
  $updated = [bool] $b -and ($b.Version -eq $newVersion -or $b.Version -eq ($newVersion -replace '\.0$', ''))
  Check ($script:dialog -notmatch 'Failed to uninstall old application files') 'never the bare "Failed to uninstall old application files" error'
  if ($case -eq 'all-users') {
    # without administrator rights the setup asks Windows for them; where Windows cannot give them
    # (this runner has no consent prompt), it says what to do and opens the app the person had
    Check ($updated -or $script:dialog -match 'Windows has to allow the update') "updated ($($b.Version)), or told what to do ($r)"
    if (-not $updated) { Start-Sleep -Seconds 5; Check ((Get-AppProcesses $a.Dir).Count -gt 0) 'and the app is open again' }
  } else {
    Check ($r -eq 'finished') "the update finished without a dialog ($r)"
    Check $updated "the new version is installed ($($b.Version))"
  }
  Save-Screen "after-$case"
}

Step 'App logs'
$appLogs = Join-Path $env:APPDATA 'Dexterity Connect\logs'
if (Test-Path $appLogs) { Copy-Item -Recurse $appLogs (Join-Path $Logs 'app') }
if ($failures) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'all checks passed'
