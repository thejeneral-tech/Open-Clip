@echo off
:: ============================================================================
::  CHECK_TREND_VAULT_HEALTH.bat
::  Production health check. Performs:
::   - port reachability (3001)
::   - folder sanity (trend-vault-output, public/custom-audio, public/captions, logs)
::   - .env presence
::   - Drive sync requests folder (if configured)
::  Output is colour-coded text. No services are started/restarted.
:: ============================================================================

:: Self-relaunch so the window stays open on double-click
if /i not "%~1"=="--keepopen" (
    start "Trend Vault Health Check" cmd /k call "%~f0" --keepopen
    exit /b 0
)
setlocal EnableDelayedExpansion
title Trend Vault Health Check
color 0B

:: Resolve project root (one level up from bats/)
pushd "%~dp0.."
set "TREND_VAULT_DIR=%CD%"
popd

echo.
echo ============================================================
echo   Trend Vault System Health Check
echo ============================================================
echo.

:: ── 1. Port reachability ──────────────────────────────────────────────────
echo [1/4] Port reachability
set "WEB_OK=false"

curl -s --max-time 2 http://localhost:3001 >nul 2>&1
if not errorlevel 1 ( set "WEB_OK=true" & echo     [RUNNING]  Trend Vault Web App      :3001 ) else echo     [OFFLINE]  Trend Vault Web App      :3001
echo.

:: ── 2. Trend Vault web app response ────────────────────────────────────────────
echo [2/4] Trend Vault web app
if "%WEB_OK%"=="true" (
    echo     Trend Vault is up at http://localhost:3001/trend-vault
) else (
    echo     Trend Vault offline -- run START_TREND_VAULT_DAILY.bat to start
)
echo.

:: ── 3. Folder sanity ──────────────────────────────────────────────────────
echo [3/4] Folder sanity (key paths exist)
call :CHECK_DIR "trend-vault-output"
call :CHECK_DIR "public\custom-audio"
call :CHECK_DIR "public\captions"
call :CHECK_DIR "logs"
call :CHECK_DIR "outputs\voices"
call :CHECK_DIR "data\drafts"
echo.

:: ── 4. .env + Drive sync config ───────────────────────────────────────────
echo [4/4] Config files
if exist "%TREND_VAULT_DIR%\.env" ( echo     [OK]   .env exists ) else echo     [MISSING] .env -- API keys will be unavailable
if exist "%TREND_VAULT_DIR%\data\sync.config.json" (
    echo     [OK]   data\sync.config.json exists
) else (
    echo     [INFO] data\sync.config.json missing -- Drive sync not configured (laptop normal)
)
echo.

echo ============================================================
echo   Health check complete.
echo   To start everything:  START_TREND_VAULT_DAILY.bat
echo   To stop everything:   STOP_TREND_VAULT_SYSTEM.bat
echo ============================================================
echo.
pause
exit /b 0

:CHECK_DIR
if exist "%TREND_VAULT_DIR%\%~1\" (
    echo     [OK]   %~1
) else (
    echo     [MISSING] %~1
)
goto :eof
