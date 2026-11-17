@echo off
rem Double-click to deploy the internet gateway and the Dexterity Meet meeting site to Cloudflare
rem (see docs\DEXTERITY-MEET.md and docs\REMOTE-ACCESS.md). Options: -Fingerprint <it>, -SiteName <name>, -GatewayOnly
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy-Gateway.ps1" %*
echo.
pause
