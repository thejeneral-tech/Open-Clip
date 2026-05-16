@echo off
title Trend Vault — Setup & Start
cd /d "%~dp0"

echo.
echo ============================================================
echo   Trend Vault — Install Dependencies and Start
echo ============================================================
echo.

:: Check if node_modules exists
if exist "node_modules\" (
    echo [OK] node_modules found, skipping install.
    goto :start
)

echo [..] node_modules missing — running npm install...
echo      This may take a minute on first run.
echo.
npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Is Node.js installed?
    pause
    exit /b 1
)
echo.
echo [OK] Dependencies installed.

:start
echo.
echo ============================================================
echo   Starting services...
echo ============================================================
echo.

:: Start Web App in a new window
start "Trend Vault — Web App" cmd /k "cd /d "%~dp0" && npm start"

:: Wait a moment then start Render Worker
timeout /t 2 /nobreak >nul
start "Trend Vault — Render Worker" cmd /k "cd /d "%~dp0" && npx tsx render-worker.ts"

echo.
echo [OK] Both services started in separate windows.
echo      Web App:       http://localhost:3001/trend-vault
echo      Render Worker: port 4000
echo.
echo You can close this window.
timeout /t 5
