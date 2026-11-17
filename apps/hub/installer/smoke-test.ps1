<#
  Installs, repairs, upgrades and removes the hub on a clean Windows PC (the GitHub runner), with the
  real DexterityConnectHub-Setup.exe and hub zip of this build. A release is not published unless
  this passes. It changes the PC (a service, firewall rules, sleep settings), so run it by hand only
  on a throw-away PC or VM:

    pwsh apps/hub/installer/smoke-test.ps1 -Setup .\DexterityConnectHub-Setup-0.1.42.exe -Zip .\DexterityConnectHub-0.1.42-win-x64.zip

  1. A fresh install with the setup, then the setup again (repair), then uninstall keeping the data,
     a reinstall that finds the same hub, and uninstall with /REMOVEDATA.
  2. An install made the old way from the zip (WinSW and netsh, as the old Install-Hub.cmd did),
     upgraded in place by the setup without a second service or a new data folder, then uninstalled.
  3. The zip's own Install-Hub.ps1 (what Install-Hub.cmd runs) from another folder: it finds the
     data the uninstalled hub kept, repairs, and removes.
#>
param(
  [Parameter(Mandatory)] [string] $Setup,
  [Parameter(Mandatory)] [string] $Zip,
  [string] $Work = (Join-Path $env:RUNNER_TEMP 'hub-smoke')
)
$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TEMP -and -not $PSBoundParameters.ContainsKey('Work')) { $Work = Join-Path $env:TEMP 'hub-smoke' }

$Id = 'DexterityConnectHub'
$ProgramDir = Join-Path $env:ProgramFiles 'Dexterity Connect Hub'
$DefaultData = Join-Path $env:ProgramData 'Dexterity Connect Hub\hub-data'
$Uninstaller = 'Uninstall Dexterity Connect Hub.exe'
$UninstKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DexterityConnectHub'
$PS51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Setup = (Resolve-Path $Setup).Path
$Zip = (Resolve-Path $Zip).Path

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Check([bool] $ok, [string] $what) {
  if ($ok) { Write-Host "  ok    $what" } else { Write-Host "  FAIL  $what" -ForegroundColor Red; throw "Check failed: $what" }
}

function Invoke-Setup([string[]] $argv) {
  $p = Start-Process -FilePath $Setup -ArgumentList $argv -Wait -PassThru
  return $p.ExitCode
}

function Invoke-Uninstall([string] $dir, [string[]] $more = @()) {
  # _?= runs the uninstaller in place and waits for it (it then cannot delete itself)
  $exe = Join-Path $dir $Uninstaller
  $p = Start-Process -FilePath $exe -ArgumentList (@('/S') + $more + @("_?=$dir")) -Wait -PassThru
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue   # only when now empty
  return $p.ExitCode
}

function Get-Health {
  $out = & curl.exe -sk --max-time 5 "https://127.0.0.1:47900/health" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch { return $null }
}

function Get-HubServices {
  return @(Get-CimInstance Win32_Service | Where-Object { $_.Name -eq $Id -or $_.PathName -like '*DexterityConnectHubService*' })
}

function Assert-Hub([string] $dir, [string] $data) {
  $svcs = Get-HubServices
  Check ($svcs.Count -eq 1) "exactly one hub service (found $($svcs.Count))"
  $svc = $svcs[0]
  Check ($svc.State -eq 'Running') "the service is running ($($svc.State))"
  Check ($svc.PathName -like "*$dir\DexterityConnectHubService.exe*") "the service runs from $dir ($($svc.PathName))"
  Check ($svc.StartName -eq 'LocalSystem') "it runs as LocalSystem ($($svc.StartName))"
  $reg = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$Id"
  Check ($reg.Start -eq 2 -and $reg.DelayedAutostart -eq 1) 'automatic (delayed) start'
  $failure = (& sc.exe qfailure $Id 5000) -join "`n"
  Check (([regex]::Matches($failure, 'RESTART')).Count -eq 3) 'restarts three times after a failure'
  $health = Get-Health
  Check ($null -ne $health -and $health.ok -eq $true) '/health answers ok'
  foreach ($r in @(@{ Name = 'Dexterity Connect Hub (connections)'; Count = 1; Program = "$dir\DexterityConnectHub.exe" },
                   @{ Name = 'Dexterity Connect Hub (discovery)'; Count = 1; Program = "$dir\DexterityConnectHub.exe" },
                   @{ Name = 'Dexterity Connect Hub (large Rooms)'; Count = 2; Program = "$dir\mediasoup-worker.exe" })) {
    $rules = @(Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)
    Check ($rules.Count -eq $r.Count) "firewall: $($r.Name) x$($r.Count) (found $($rules.Count))"
    foreach ($rule in $rules) {
      $prog = ($rule | Get-NetFirewallApplicationFilter).Program
      Check ($prog -eq $r.Program) "  for $prog"
    }
  }
  Check (Test-Path -LiteralPath (Join-Path $data 'hub.db')) "the data is in $data"
  $loc = @(Get-Content -LiteralPath (Join-Path $dir 'hub-data-location.txt')) | Where-Object { $_ -and -not $_.StartsWith('#') } | Select-Object -First 1
  Check ($loc -eq $data) "hub-data-location.txt names it ($loc)"
  Check (Test-Path -LiteralPath (Join-Path $env:ProgramData 'Dexterity Connect Hub\setup.log')) 'setup.log is written'
  return $health
}

function Assert-Removed([string] $dir) {
  Check ((Get-HubServices).Count -eq 0) 'no hub service left'
  Check (@(Get-NetFirewallRule -Group 'Dexterity Connect Hub' -ErrorAction SilentlyContinue).Count -eq 0 -and
         @(Get-NetFirewallRule -DisplayName 'Dexterity Connect Hub (connections)' -ErrorAction SilentlyContinue).Count -eq 0) 'no hub firewall rules left'
  Check ($null -eq (Get-Health)) 'nothing answers on 47900'
  Check (-not (Test-Path -LiteralPath (Join-Path $dir 'DexterityConnectHub.exe'))) "the programs are gone from $dir"
}

function Show-Logs {
  $log = Join-Path $env:ProgramData 'Dexterity Connect Hub\setup.log'
  if (Test-Path $log) { Write-Host '---- setup.log (end)'; Get-Content $log -Tail 80 }
}

try {
  # ---------------------------------------------------------------- 1. the setup on a clean PC
  Step 'Fresh install: DexterityConnectHub-Setup.exe /S'
  Check ((Get-HubServices).Count -eq 0) 'no hub service before the test'
  $code = Invoke-Setup @('/S')
  Check ($code -eq 0) "setup exit code 0 (got $code)"
  $h1 = Assert-Hub $ProgramDir $DefaultData
  Check ((Get-ItemProperty $UninstKey).InstallLocation -eq $ProgramDir) 'listed in Apps & features'
  Set-Content -LiteralPath (Join-Path $DefaultData 'smoke-marker.txt') 'keep me'
  $acl = (Get-Acl -LiteralPath $DefaultData).Access | ForEach-Object { $_.IdentityReference.Value }
  Check (-not ($acl -match 'Users$')) "only SYSTEM and Administrators can open the data folder ($($acl -join ', '))"

  Step 'Run the setup again (repair): same service, same rules, same data'
  $code = Invoke-Setup @('/S')
  Check ($code -eq 0) "setup exit code 0 (got $code)"
  $h2 = Assert-Hub $ProgramDir $DefaultData
  Check ($h2.fingerprint -eq $h1.fingerprint) 'the same hub (certificate fingerprint unchanged)'
  Check (Test-Path -LiteralPath (Join-Path $DefaultData 'smoke-marker.txt')) 'the data was not touched'

  Step 'Uninstall, keeping the data'
  $code = Invoke-Uninstall $ProgramDir
  Check ($code -eq 0) "uninstall exit code 0 (got $code)"
  Assert-Removed $ProgramDir
  Check (Test-Path -LiteralPath (Join-Path $DefaultData 'smoke-marker.txt')) 'the data is kept'
  Check (-not (Test-Path $UninstKey)) 'gone from Apps & features'

  Step 'Install again: the same hub comes back'
  $code = Invoke-Setup @('/S', '/NOPOWER')
  Check ($code -eq 0) "setup exit code 0 (got $code)"
  $h3 = Assert-Hub $ProgramDir $DefaultData
  Check ($h3.fingerprint -eq $h1.fingerprint) 'the same hub (certificate fingerprint unchanged)'

  Step 'Uninstall with /REMOVEDATA'
  $code = Invoke-Uninstall $ProgramDir @('/REMOVEDATA')
  Check ($code -eq 0) "uninstall exit code 0 (got $code)"
  Assert-Removed $ProgramDir
  Check (-not (Test-Path -LiteralPath $DefaultData)) 'the data is deleted'

  # ---------------------------------------------------------------- 2. upgrade from the old zip layout
  Step 'An install made the old way from the zip (WinSW, netsh, hub-data beside the program)'
  $zipRoot = Join-Path $Work 'zip'
  Remove-Item -Recurse -Force $zipRoot -ErrorAction SilentlyContinue
  Expand-Archive -Path $Zip -DestinationPath $zipRoot
  $old = Join-Path $zipRoot 'DexterityConnectHub'
  & "$old\DexterityConnectHubService.exe" install
  Check ($LASTEXITCODE -eq 0) 'WinSW installed the service'
  & netsh advfirewall firewall add rule name="Dexterity Connect Hub (connections)" dir=in action=allow protocol=TCP localport=47900 profile=any program="$old\DexterityConnectHub.exe" | Out-Null
  & netsh advfirewall firewall add rule name="Dexterity Connect Hub (discovery)" dir=in action=allow protocol=UDP localport=47901 profile=any program="$old\DexterityConnectHub.exe" | Out-Null
  & "$old\DexterityConnectHubService.exe" start
  $deadline = (Get-Date).AddSeconds(120)
  while (-not (Get-Health) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  $old1 = Get-Health
  Check ($null -ne $old1) 'the old-style hub answers'
  Check (Test-Path -LiteralPath "$old\hub-data\hub.db") 'its data is in hub-data beside it'
  Set-Content -LiteralPath "$old\hub-data\smoke-marker.txt" 'keep me'

  Step 'The setup upgrades it in place'
  $code = Invoke-Setup @('/S')
  Check ($code -eq 0) "setup exit code 0 (got $code)"
  $old2 = Assert-Hub $old "$old\hub-data"
  Check ($old2.fingerprint -eq $old1.fingerprint) 'the same hub (certificate fingerprint unchanged)'
  Check (Test-Path -LiteralPath "$old\hub-data\smoke-marker.txt") 'the data was not touched'
  Check (-not (Test-Path -LiteralPath (Join-Path $ProgramDir 'DexterityConnectHub.exe'))) 'nothing was installed a second time in Program Files'
  Check (-not (Test-Path -LiteralPath (Join-Path $DefaultData 'hub.db'))) 'no second, empty hub data folder'
  Check ((Get-ItemProperty $UninstKey).InstallLocation -eq $old) 'Apps & features points at the existing folder'

  Step 'Uninstall it (data kept beside it)'
  $code = Invoke-Uninstall $old
  Check ($code -eq 0) "uninstall exit code 0 (got $code)"
  Assert-Removed $old
  Check (Test-Path -LiteralPath "$old\hub-data\smoke-marker.txt") 'the data is kept'

  # ---------------------------------------------------------------- 3. the zip's own script
  Step 'The zip fallback: Install-Hub.ps1 (what Install-Hub.cmd runs), from another folder'
  # the hub uninstalled above kept its data, so this install carries on with it rather than
  # starting a second, empty hub
  $zip2 = Join-Path $Work 'zip2'
  Remove-Item -Recurse -Force $zip2 -ErrorAction SilentlyContinue
  Expand-Archive -Path $Zip -DestinationPath $zip2
  $z = Join-Path $zip2 'DexterityConnectHub'
  & $PS51 -NoProfile -ExecutionPolicy Bypass -File "$z\Install-Hub.ps1" -InstallDir "$z\."
  Check ($LASTEXITCODE -eq 0) "Install-Hub.ps1 exit code 0 (got $LASTEXITCODE)"
  $z1 = Assert-Hub $z "$old\hub-data"
  Check ($z1.fingerprint -eq $old1.fingerprint) 'the same hub as before (its kept data was found)'
  & $PS51 -NoProfile -ExecutionPolicy Bypass -File "$z\Install-Hub.ps1" -InstallDir "$z\."
  Check ($LASTEXITCODE -eq 0) 'and again (repair)'
  $null = Assert-Hub $z "$old\hub-data"
  & $PS51 -NoProfile -ExecutionPolicy Bypass -File "$z\Install-Hub.ps1" -InstallDir "$z\." -Uninstall
  Check ($LASTEXITCODE -eq 0) 'Install-Hub.ps1 -Uninstall exit code 0'
  Check ((Get-HubServices).Count -eq 0) 'no hub service left'
  Check (Test-Path -LiteralPath "$old\hub-data\smoke-marker.txt") 'the data is kept'

  Write-Host ''
  Write-Host 'The hub setup works: install, repair, uninstall, reinstall, upgrade from the zip, and the zip fallback.' -ForegroundColor Green
} catch {
  Write-Host $_ -ForegroundColor Red
  Show-Logs
  exit 1
}
