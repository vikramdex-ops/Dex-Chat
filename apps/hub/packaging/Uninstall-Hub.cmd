@echo off
rem Removes the Dexterity Connect Hub service and firewall rules. Your data in hub-data is kept.
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
DexterityConnectHubService.exe stop >nul 2>&1
DexterityConnectHubService.exe uninstall
netsh advfirewall firewall delete rule name="Dexterity Connect Hub (connections)" >nul 2>&1
netsh advfirewall firewall delete rule name="Dexterity Connect Hub (discovery)" >nul 2>&1
echo.
echo  The hub service was removed. Your data is still in %~dp0hub-data
echo.
pause
