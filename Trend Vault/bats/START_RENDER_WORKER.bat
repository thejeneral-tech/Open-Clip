@echo off
title Trend Vault Render Worker (port 4000)
:: Change to project root (one level up from bats/)
cd /d "%~dp0.."

echo.
echo  =============================================
echo    Trend Vault Render Worker  -  Port 4000
echo  =============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERROR: Node.js is not installed.
  echo  Download it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

:: Check .env
if not exist ".env" (
  echo  WARNING: .env file not found.
  echo.
)

:: Install / verify dependencies
echo  Checking dependencies...
call npm install --silent
if %errorlevel% neq 0 (
  echo.
  echo  ERROR: npm install failed.
  pause
  exit /b 1
)
echo  [OK] Dependencies ready.
echo.

:: Read optional port from .env
set RENDER_WORKER_PORT=4000
for /f "tokens=2 delims==" %%A in ('findstr /i "RENDER_WORKER_PORT" .env 2^>nul') do set RENDER_WORKER_PORT=%%A

echo  =============================================
echo.
echo    Worker URL:   http://localhost:%RENDER_WORKER_PORT%
echo    Health:       http://localhost:%RENDER_WORKER_PORT%/api/render/health
echo    Jobs:         http://localhost:%RENDER_WORKER_PORT%/api/render/jobs
echo.
echo    To enable, add this to your .env on the dashboard machine:
echo      RENDER_WORKER_URL=http://localhost:%RENDER_WORKER_PORT%
echo.
echo    Press Ctrl+C to stop.
echo.
echo  =============================================
echo.

call npm run dev:worker

pause
