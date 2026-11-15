@echo off
rem Double-click to deploy the internet gateway to Cloudflare (see docs\REMOTE-ACCESS.md).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy-Gateway.ps1" %*
echo.
pause
