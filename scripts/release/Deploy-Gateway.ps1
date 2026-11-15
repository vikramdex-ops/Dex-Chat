<#
  Deploys the internet gateway (apps/gateway) to the office's Cloudflare account from this PC.
  Same as the GitHub "gateway" workflow, without GitHub. See docs/REMOTE-ACCESS.md.

    Deploy-Gateway.cmd                      asks for the Cloudflare token and account id
    Deploy-Gateway.cmd -Fingerprint AB:CD…  also pins the gateway to the office hub

  The token is read without showing it and is not saved anywhere by this script.
#>
[CmdletBinding()]
param([string] $AccountId = $env:CLOUDFLARE_ACCOUNT_ID, [string] $Fingerprint = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Install Node.js 22 LTS from https://nodejs.org first.' -ForegroundColor Red; exit 1 }

$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) {
  $sec = Read-Host 'Cloudflare API token ("Edit Cloudflare Workers")' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $AccountId) { $AccountId = Read-Host 'Cloudflare Account ID (Workers & Pages overview, right side)' }
if (-not $token -or -not $AccountId) { Write-Host 'Both the token and the account id are needed.' -ForegroundColor Red; exit 1 }
$env:CLOUDFLARE_API_TOKEN = $token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId

if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE -ne 0) { exit 1 } }
Push-Location apps/gateway
$log = npx wrangler deploy 2>&1 | Tee-Object -Variable lines
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'The deployment failed (see above).' -ForegroundColor Red; exit 1 }
if ($Fingerprint) {
  $Fingerprint | npx wrangler secret put HUB_FINGERPRINT
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'Could not pin the gateway to the hub.' -ForegroundColor Red; exit 1 }
}
Pop-Location
$url = ($lines | Select-String -Pattern 'https://[a-z0-9.-]+\.workers\.dev' -AllMatches | ForEach-Object { $_.Matches } | Select-Object -First 1).Value
Remove-Item Env:CLOUDFLARE_API_TOKEN
Write-Host ''
Write-Host 'Gateway deployed.' -ForegroundColor Green
if ($url) { Write-Host "Paste this address into Control room > Outside the office:  $url" }
if ($Fingerprint) { Write-Host 'Pinned to the office hub.' } else { Write-Host 'Next: copy the Fingerprint from Control room > Outside the office and run  Deploy-Gateway.cmd -Fingerprint <it>' }
