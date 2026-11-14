@echo off
rem Dexterity Connect Hub installer. Installs the hub from THIS folder as a Windows service.
rem Put this folder where the hub should live (for example D:\Dexterity Connect Hub) before running.
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo Installing Dexterity Connect Hub from %~dp0
echo.
DexterityConnectHubService.exe status | find /i "NonExistent" >nul
if not errorlevel 1 (
  DexterityConnectHubService.exe install || goto :fail
)
netsh advfirewall firewall delete rule name="Dexterity Connect Hub (connections)" >nul 2>&1
netsh advfirewall firewall delete rule name="Dexterity Connect Hub (discovery)" >nul 2>&1
netsh advfirewall firewall add rule name="Dexterity Connect Hub (connections)" dir=in action=allow protocol=TCP localport=47900 profile=any program="%~dp0DexterityConnectHub.exe" >nul || goto :fail
netsh advfirewall firewall add rule name="Dexterity Connect Hub (discovery)" dir=in action=allow protocol=UDP localport=47901 profile=any program="%~dp0DexterityConnectHub.exe" >nul || goto :fail
DexterityConnectHubService.exe restart || DexterityConnectHubService.exe start || goto :fail
echo.
echo  Dexterity Connect Hub is installed and running.
echo  It starts automatically with Windows, even before anyone signs in.
echo  Data folder: %~dp0hub-data    Logs: %~dp0logs
echo.
echo  Next: install Dexterity Connect on your own PC and open it. The first person
echo  to join becomes the administrator and approves everyone else.
echo.
pause
exit /b 0
:fail
echo.
echo  Installation did not finish. See the messages above, or the logs folder.
pause
exit /b 1
