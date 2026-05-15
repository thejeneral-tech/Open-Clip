@echo off
:: ============================================================================
::  CHECK_ZODIAC_HEALTH.bat
::  Production health check. Performs:
::   - port reachability (3001)
::   - folder sanity (zodiac-output, public/custom-audio, public/captions, logs)
::   - .env presence
::   - Drive sync requests folder (if configured)
::  Output is colour-coded text. No services are started/restarted.
:: ============================================================================

:: Self-relaunch so the window stays open on double-click
if /i not "%~1"=="--keepopen" (
    start "Zodiac Health Check" cmd /k call "%~f0" --keepopen
    exit /b 0
)
setlocal EnableDelayedExpansion
title Zodiac Health Check
color 0B

set "ZODIAC_DIR=%~dp0"
if "%ZODIAC_DIR:~-1%"=="\" set "ZODIAC_DIR=%ZODIAC_DIR:~0,-1%"

echo.
echo ============================================================
echo   Zodiac System Health Check
echo ============================================================
echo.

:: ── 1. Port reachability ──────────────────────────────────────────────────
echo [1/4] Port reachability
set "WEB_OK=false"

curl -s --max-time 2 http://localhost:3001 >nul 2>&1
if not errorlevel 1 ( set "WEB_OK=true" & echo     [RUNNING]  Zodiac Web App      :3001 ) else echo     [OFFLINE]  Zodiac Web App      :3001
echo.

:: ── 2. Zodiac web app response ────────────────────────────────────────────
echo [2/4] Zodiac web app
if "%WEB_OK%"=="true" (
    echo     Zodiac is up at http://localhost:3001/zodiac
) else (
    echo     Zodiac offline -- run START_ZODIAC_DAILY.bat to start
)
echo.

:: ── 3. Folder sanity ──────────────────────────────────────────────────────
echo [3/4] Folder sanity (key paths exist)
call :CHECK_DIR "zodiac-output"
call :CHECK_DIR "public\custom-audio"
call :CHECK_DIR "public\captions"
call :CHECK_DIR "logs"
call :CHECK_DIR "outputs\voices"
call :CHECK_DIR "data\drafts"
echo.

:: ── 4. .env + Drive sync config ───────────────────────────────────────────
echo [4/4] Config files
if exist "%ZODIAC_DIR%\.env" ( echo     [OK]   .env exists ) else echo     [MISSING] .env -- API keys will be unavailable
if exist "%ZODIAC_DIR%\sync.config.json" (
    echo     [OK]   sync.config.json exists
) else (
    echo     [INFO] sync.config.json missing -- Drive sync not configured (laptop normal)
)
echo.

echo ============================================================
echo   Health check complete.
echo   To start everything:  START_ZODIAC_DAILY.bat
echo   To stop everything:   STOP_ZODIAC_SYSTEM.bat
echo ============================================================
echo.
pause
exit /b 0

:CHECK_DIR
if exist "%ZODIAC_DIR%\%~1\" (
    echo     [OK]   %~1
) else (
    echo     [MISSING] %~1
)
goto :eof
