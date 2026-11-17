<#
  Builds a Dexterity Connect release on this Windows PC, and (with -Publish) puts it where the
  installed apps look for updates. It does locally what the GitHub build used to do on every push.

    Build-Release.cmd                         build everything into D:\DexterityConnect-Releases\<version>
    Build-Release.cmd -Publish                build, then publish to the release page and the update feed
    Build-Release.cmd -Channel beta -Publish  publish to the beta channel (people who opted in)
    Build-Release.cmd -SkipAndroid            Windows app and hub only

  Needs: Node.js 22, Git. For the Android APK: JDK 21 and the Android SDK (ANDROID_HOME).
  The hub setup is built with NSIS: the copy the Windows app's build downloads is used, or an
  installed NSIS (winget install NSIS.NSIS).
  For -Publish: the GitHub CLI (gh), signed in with access to the public release repository.
  See docs/RELEASING.md for the one-time setup.
#>
[CmdletBinding()]
param(
  [ValidateSet('stable', 'beta')] [string] $Channel = '',
  [string] $Out = 'D:\DexterityConnect-Releases',
  [string] $Version = '',
  [switch] $Publish,
  [switch] $SkipAndroid,
  [switch] $SkipTests,
  [string] $PublicRepo = 'dexterity-admin/dexterity-connect'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "STOPPED: $text" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]] $argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv -join ' ') failed (exit $LASTEXITCODE)" }
}
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ------------------------------------------------------------------ checks
Step 'Checking this PC'
if (-not (Have node)) { Fail 'Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this again.' }
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) { Fail "Node.js 22 or newer is needed (this PC has $(node -v))." }
if (-not (Have git)) { Fail 'Git is not installed. Install it from https://git-scm.com and run this again.' }
if ($root -match '^[Cc]:') { Write-Host "Note: the repository is on drive C: ($root). Builds work, but the office keeps development files off C:." -ForegroundColor Yellow }
$dirty = git status --porcelain
if ($dirty) { Write-Host 'Note: there are uncommitted changes; they go into this build.' -ForegroundColor Yellow }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$commit = (git rev-parse --short HEAD).Trim()
if (-not $Channel) { $Channel = if ($branch -eq 'main') { 'stable' } else { 'beta' } }

$android = -not $SkipAndroid
if ($android) {
  $java = Have java
  $sdk = $env:ANDROID_HOME; if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
  if (-not $java -or -not $sdk -or -not (Test-Path $sdk)) {
    Write-Host 'Android: JDK 21 or the Android SDK (ANDROID_HOME) was not found, so the APK is skipped this time. See docs/RELEASING.md.' -ForegroundColor Yellow
    $android = $false
  }
}
if ($Publish -and -not (Have gh)) { Fail 'Publishing needs the GitHub CLI: install it from https://cli.github.com, run "gh auth login", then run this again.' }
if ($Publish) {
  gh auth status 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'The GitHub CLI is not signed in. Run "gh auth login" and run this again.' }
}

# version: major.minor from the app, then the date and hour, so every build is newer than the last
if (-not $Version) {
  $base = (node -p "require('./apps/desktop/package.json').version.split('.').slice(0,2).join('.')").Trim()
  $Version = "$base.$((Get-Date).ToString('yyMMddHH'))"
}
$build = [int]($Version.Split('.')[-1])
$dest = Join-Path $Out $Version
New-Item -ItemType Directory -Force $dest | Out-Null
Write-Host "Version $Version ($Channel) from $branch @ $commit -> $dest"

# ------------------------------------------------------------------ build
Step 'Installing dependencies (npm ci)'
Run npm @('ci')

if (-not $SkipTests) {
  Step 'Typecheck and tests'
  Run npm @('run', 'typecheck')
  Run npm @('test')
}

Step 'Windows app (installer)'
Run npm @('version', $Version, '--no-git-tag-version', '-w', '@dex/desktop', '--allow-same-version')
Run npm @('run', 'build', '-w', '@dex/desktop')
Push-Location apps/desktop
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:GH_TOKEN = ''
Run npx @('electron-builder', '--win', 'nsis', '--publish', 'never')
Pop-Location
Get-ChildItem apps/desktop/release -Filter "DexterityConnect-Setup-$Version.exe" | Copy-Item -Destination $dest

Step 'Office hub (zip and DexterityConnectHub-Setup)'
Run node @('apps/hub/scripts/build.mjs', '--sea')
$hubDir = Join-Path $env:TEMP "DexterityConnectHub-$Version"
Remove-Item -Recurse -Force $hubDir -ErrorAction SilentlyContinue
$pkg = Join-Path $hubDir 'DexterityConnectHub'
New-Item -ItemType Directory -Force $pkg | Out-Null
Copy-Item apps/hub/dist/DexterityConnectHub.exe $pkg
# the relay for large Rooms (mediasoup's worker, ISC licence) runs beside the hub
Copy-Item node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe $pkg
Copy-Item apps/hub/packaging/* $pkg
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile (Join-Path $pkg 'DexterityConnectHubService.exe')
Compress-Archive -Force -Path $pkg -DestinationPath (Join-Path $dest "DexterityConnectHub-$Version-win-x64.zip")
# the installer for the server PC, from the same files (apps/hub/installer/hub-setup.nsi)
Run node @('apps/hub/scripts/build-setup.mjs', '--stage', $pkg, '--version', $Version, '--out', (Join-Path $dest "DexterityConnectHub-Setup-$Version.exe"))

if ($android) {
  Step 'Android app (APK)'
  Run npm @('run', 'build', '-w', '@dex/mobile')
  Push-Location apps/mobile
  Run npx @('cap', 'sync', 'android')
  Pop-Location
  Push-Location apps/mobile/android
  Run .\gradlew.bat @('assembleRelease', '--no-daemon', "-PdexVersionCode=$build", "-PdexVersionName=$Version")
  Pop-Location
  Copy-Item apps/mobile/android/app/build/outputs/apk/release/app-release.apk (Join-Path $dest "DexterityConnect-$Version.apk")
}

# put the app's version back as it was in the repository
git checkout -- apps/desktop/package.json package-lock.json 2>$null

# release notes: the changes since the last published version on this channel
$notes = Join-Path $env:TEMP "dexconnect-notes-$Version.md"
$last = ''
try { $last = (gh release list --repo $PublicRepo --limit 1 --json tagName -q '.[0].tagName' 2>$null) } catch { }
if ($last) { git log --no-merges --format='- %s' "$last..HEAD" 2>$null | Select-Object -First 40 | Set-Content $notes -Encoding utf8 }
if (-not (Test-Path $notes) -or -not (Get-Content $notes)) { git log --no-merges --format='- %s' -n 30 | Set-Content $notes -Encoding utf8 }

Step 'Checksums and the update feed'
$feedDir = Join-Path $dest 'feed'
Run node @('scripts/release/make-feed.mjs', '--dir', $dest, '--channel', $Channel, '--version', $Version,
  '--base-url', "https://github.com/$PublicRepo/releases/download/v$Version", '--notes-file', $notes, '--out', (Join-Path $feedDir "$Channel.json"))

Write-Host ""
Write-Host "Built:" -ForegroundColor Green
Get-ChildItem $dest -File | ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }

if (-not $Publish) {
  Write-Host ""
  Write-Host "Not published. To send it to everyone's apps, run:  Build-Release.cmd -Publish -Version $Version -SkipTests" -ForegroundColor Yellow
  Write-Host "(or upload the files in $dest by hand; installed apps update only from the feed)."
  exit 0
}

# ------------------------------------------------------------------ publish
Step "Publishing $Version to $PublicRepo ($Channel)"
$title = "Dexterity Connect $Version" + $(if ($Channel -eq 'beta') { ' (beta)' } else { '' })
$files = @(Get-ChildItem $dest -File | ForEach-Object { $_.FullName })
# fixed-name copies: releases/latest/download/<name> always gives the newest stable build, so the
# landing page and docs/OFFICE-SETUP.md link to them directly (the same names as the GitHub workflow)
$alias = Join-Path $env:TEMP "dexconnect-alias-$Version"
Remove-Item -Recurse -Force $alias -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $alias | Out-Null
foreach ($f in Get-ChildItem $dest -File) {
  $a = switch -Wildcard ($f.Name) {
    'DexterityConnectHub-Setup*.exe' { 'DexterityConnectHub-Setup.exe'; break }
    '*Setup*.exe' { 'DexterityConnect-Setup.exe'; break }
    '*mac-arm64.dmg' { 'DexterityConnect-mac-arm64.dmg'; break }
    '*mac-x64.dmg' { 'DexterityConnect-mac-x64.dmg'; break }
    '*.apk' { 'DexterityConnect.apk'; break }
    '*Hub*.zip' { 'DexterityConnectHub-win-x64.zip'; break }
    default { $null }
  }
  if ($a) { Copy-Item $f.FullName (Join-Path $alias $a); $files += (Join-Path $alias $a) }
}
Run gh (@('release', 'create', "v$Version", '--repo', $PublicRepo, '--draft', '--title', $title, '--notes-file', $notes) + $files)
$flags = if ($Channel -eq 'beta') { @('--prerelease', '--latest=false') } else { @('--latest') }
Run gh (@('release', 'edit', "v$Version", '--repo', $PublicRepo, '--draft=false') + $flags)

# the feed installed apps read (branch update-feed of the public repository)
$feedRepo = Join-Path $env:TEMP "dexconnect-feed-$Version"
Remove-Item -Recurse -Force $feedRepo -ErrorAction SilentlyContinue
Run gh @('auth', 'setup-git')
git clone --quiet --depth 1 --branch update-feed "https://github.com/$PublicRepo.git" $feedRepo
if ($LASTEXITCODE -ne 0) { Fail 'Could not fetch the update feed branch (update-feed).' }
Copy-Item (Join-Path $feedDir "$Channel.json") (Join-Path $feedRepo "$Channel.json") -Force
Push-Location $feedRepo
Run git @('add', "$Channel.json")
Run git @('-c', 'user.name=Dexterity Connect release', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '-q', '-m', "${Channel}: $Version")
Run git @('push', '-q', 'origin', 'update-feed')
Pop-Location

Write-Host ""
Write-Host "Published $Version on the $Channel channel. Installed apps pick it up within the hour." -ForegroundColor Green
Write-Host "Release page: https://github.com/$PublicRepo/releases/tag/v$Version"
