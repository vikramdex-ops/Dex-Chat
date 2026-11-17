@echo off
rem Dexterity Connect Hub: installs (or repairs, or upgrades) the hub from THIS folder as a Windows service.
rem The easier way is DexterityConnectHub-Setup.exe; this is for the zip. Both run Install-Hub.ps1.
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
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Hub.ps1" -InstallDir "%~dp0." %*
if errorlevel 1 goto :fail
echo.
echo  Data folder and logs: see above. Setup log: %ProgramData%\Dexterity Connect Hub\setup.log
echo.
pause
exit /b 0
:fail
echo.
echo  Installation did not finish. See the messages above, or
echo  %ProgramData%\Dexterity Connect Hub\setup.log and the logs folder here.
pause
exit /b 1
