@echo off
title Trend Vault Studio
cd /d "%~dp0.."

echo.
echo  ============================================
echo   Trend Vault Studio  ^|  Starting server...
echo  ============================================
echo.

REM Kill anything already on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do (
    echo  Stopping existing process on port 3000 [PID %%a]...
    taskkill /PID %%a /F >nul 2>&1
)

echo  Starting server...
echo  Open: http://localhost:3000/trend-vault
echo  Mainframe: http://localhost:3000/mainframe
echo  Accounts:  http://localhost:3000/accounts
echo.
echo  Press Ctrl+C to stop.
echo.

npx tsx server\server.ts

pause
