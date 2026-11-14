@echo off
setlocal
cd /d "%~dp0"

rem Keep the database and uploads in this folder (e.g. D:\lattice\data).
if "%DATA_DIR%"=="" set "DATA_DIR=%~dp0data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

echo Starting Lattice from %~dp0
node "%~dp0server\index.js"

echo.
echo Lattice stopped.
pause
