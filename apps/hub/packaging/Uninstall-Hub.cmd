@echo off
rem Removes the Dexterity Connect Hub service and firewall rules. The hub's data is kept.
rem (Installed with DexterityConnectHub-Setup.exe? Use Settings > Apps > Dexterity Connect Hub instead.)
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Hub.ps1" -InstallDir "%~dp0." -Uninstall
echo.
pause
