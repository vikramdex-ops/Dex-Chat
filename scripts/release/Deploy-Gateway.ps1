<#
  Deploys, in one run, the office's two Cloudflare parts from this PC:
    1. the internet gateway Worker (apps/gateway), and
    2. Dexterity Meet's meeting site, the Pages project "dexterity-meet" (apps/meet-site), which
       passes everything to that gateway, so every meeting has a clean address such as
       https://dexterity-meet.pages.dev/482-913-207.
  Then it prints both addresses to paste into Control room > Outside the office.
  Same as the GitHub "gateway" workflow, without GitHub. See docs/DEXTERITY-MEET.md and
  docs/REMOTE-ACCESS.md.

  Usually not needed: Control room > Outside the office > "Set up with Cloudflare" does all of this
  from the hub itself (and pins the gateway and makes the TURN key), from one pasted token. This
  script is the fallback, for a hub built without the Cloudflare parts or for the command line.

    Deploy-Gateway.cmd                          asks for the Cloudflare token and account id
    Deploy-Gateway.cmd -Fingerprint AB:CD…      also pins the gateway to the office hub
    Deploy-Gateway.cmd -SiteName dexmeet-office the meeting site under another name (if
                                                "dexterity-meet" is taken on Cloudflare)
    Deploy-Gateway.cmd -GatewayOnly             the gateway alone, as before

  The token is read without showing it and is not saved anywhere by this script. It needs the
  "Edit Cloudflare Workers" permissions plus Account > Cloudflare Pages > Edit.
#>
[CmdletBinding()]
param(
  [string] $AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
  [string] $Fingerprint = '',
  [string] $SiteName = 'dexterity-meet',
  [switch] $GatewayOnly
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Install Node.js 22 LTS from https://nodejs.org first.' -ForegroundColor Red; exit 1 }
if ($SiteName -notmatch '^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$') { Write-Host 'A site name is lower-case letters, digits and hyphens, for example dexterity-meet.' -ForegroundColor Red; exit 1 }

$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) {
  $sec = Read-Host 'Cloudflare API token ("Edit Cloudflare Workers" plus Cloudflare Pages: Edit)' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $AccountId) { $AccountId = Read-Host 'Cloudflare Account ID (Workers & Pages overview, right side)' }
if (-not $token -or -not $AccountId) { Write-Host 'Both the token and the account id are needed.' -ForegroundColor Red; exit 1 }
$env:CLOUDFLARE_API_TOKEN = $token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId
$env:WRANGLER_SEND_METRICS = 'false'

try {
  if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE -ne 0) { exit 1 } }

  # ---- 1. the gateway Worker
  Write-Host 'Deploying the gateway…' -ForegroundColor Cyan
  Push-Location apps/gateway
  $lines = npx wrangler deploy 2>&1 | Tee-Object -Variable out
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'The gateway deployment failed (see above).' -ForegroundColor Red; exit 1 }
  if ($Fingerprint) {
    $Fingerprint | npx wrangler secret put HUB_FINGERPRINT
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'Could not pin the gateway to the hub.' -ForegroundColor Red; exit 1 }
  }
  Pop-Location
  $gateway = ($out | Select-String -Pattern 'https://[a-z0-9.-]+\.workers\.dev' -AllMatches | ForEach-Object { $_.Matches } | Select-Object -First 1).Value

  # ---- 2. the meeting site (Cloudflare Pages), bound to the gateway
  $site = $null
  if (-not $GatewayOnly) {
    Write-Host "Deploying the meeting site ($SiteName)…" -ForegroundColor Cyan
    node apps/meet-site/scripts/build.mjs
    if ($LASTEXITCODE -ne 0) { Write-Host 'The meeting site could not be built.' -ForegroundColor Red; exit 1 }
    Push-Location apps/meet-site
    # the project is made the first time; afterwards Cloudflare says it exists, which is fine
    $made = npx wrangler pages project create $SiteName --production-branch main 2>&1
    if ($LASTEXITCODE -ne 0 -and -not ($made -match 'already exists|already in use by you')) {
      Pop-Location
      Write-Host ($made | Out-String)
      Write-Host "Cloudflare would not create the Pages project '$SiteName'. If the name is taken, run again with -SiteName <another name>." -ForegroundColor Red
      exit 1
    }
    npx wrangler pages deploy --project-name $SiteName --branch main --commit-dirty=true 2>&1 | Tee-Object -Variable pout
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'The meeting site deployment failed (see above). Does the token have Cloudflare Pages: Edit?' -ForegroundColor Red; exit 1 }
    Pop-Location
    $site = "https://$SiteName.pages.dev"
  }
} finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Deployed.' -ForegroundColor Green
Write-Host 'Paste into Control room > Outside the office:'
if ($gateway) { Write-Host "  Gateway address:       $gateway" }
if ($site) {
  Write-Host "  Meeting site address:  $site"
  Write-Host "  (open $site in a browser: it should say 'Join a meeting with Dexterity Design Services' once the hub is connected)"
}
if ($Fingerprint) { Write-Host 'Pinned to the office hub.' } else { Write-Host 'Next: copy the Fingerprint from Control room > Outside the office and run  Deploy-Gateway.cmd -Fingerprint <it>' }
