@echo off
rem Dexterity Connect Hub: put a backup back. Drag the backup folder (or one of the folders in its
rem "snapshots" folder) onto this file, or run: Restore-Hub.cmd "E:\DexConnectBackup"
rem It never stops the hub service itself: stop it first. The current hub-data is moved aside, not deleted.
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo.
  echo  Drag the backup folder onto Restore-Hub.cmd, or run:
  echo    Restore-Hub.cmd "E:\DexConnectBackup"
  echo.
  pause
  exit /b 2
)
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '\"%~1\"' -Verb RunAs"
  exit /b
)
sc query DexterityConnectHub | find /i "RUNNING" >nul
if not errorlevel 1 (
  echo.
  echo  The hub service is running. Stop it first:
  echo    Services ^> Dexterity Connect Hub ^> Stop, or DexterityConnectHubService.exe stop
  echo  then drag the backup folder onto Restore-Hub.cmd again.
  echo.
  pause
  exit /b 1
)
echo.
echo Restoring Dexterity Connect Hub from %~1
echo.
DexterityConnectHub.exe --restore "%~1"
if errorlevel 1 goto :fail
echo.
set /p START=Start the hub service now? (Y/N) 
if /i "%START%"=="Y" DexterityConnectHubService.exe start
pause
exit /b 0
:fail
echo.
echo  Nothing was restored. See the message above.
pause
exit /b 1
