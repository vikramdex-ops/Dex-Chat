# Builds DexSupport.exe (the IT Support service) with the C# compiler of .NET Framework 4.8, which is
# part of Windows 10 and 11: no SDK, no NuGet. Output: apps/desktop/build/support/DexSupport.exe,
# which electron-builder ships under resources/support (see package.json extraResources).
param([string]$Out = (Join-Path $PSScriptRoot '..\build\support'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw ".NET Framework 4.8 compiler not found at $csc" }
New-Item -ItemType Directory -Force $Out | Out-Null
$exe = Join-Path $Out 'DexSupport.exe'
$refs = 'System.ServiceProcess.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Core.dll', 'System.dll'
$args = @('/nologo', '/optimize+', '/platform:x64', '/target:exe', "/out:$exe") + ($refs | ForEach-Object { "/r:$_" }) + @((Join-Path $PSScriptRoot 'DexSupport.cs'))
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
Write-Output $exe
