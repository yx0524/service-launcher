@echo off
setlocal

REM Run Electron Forge dev mode by double-click
cd /d "%~dp0"

REM Ensure cmd outputs UTF-8 to avoid garbled Chinese logs
chcp 65001 >nul

echo [launcher-app-new] Starting dev mode...
echo.
npm run start

echo.
echo [launcher-app-new] Dev process exited.
pause
