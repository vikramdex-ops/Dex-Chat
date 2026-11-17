@echo off
rem Double-click to build a Dexterity Connect release on this PC (see docs\RELEASING.md).
rem Extra options pass through, for example:  Build-Release.cmd -Publish
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Release.ps1" %*
echo.
pause