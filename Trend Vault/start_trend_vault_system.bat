@echo off
:: Keep window open after script ends (double-click runs cmd /c which closes).
if /i not "%~1"=="--keepopen" (
    start "Trend Vault System Launcher" cmd /k call "%~f0" --keepopen
    exit /b 0
)
setlocal EnableDelayedExpansion
title Trend Vault System Launcher
color 0A

:: ── USER CONFIG ──────────────────────────────────────────────
set TREND_VAULT_DIR=%~dp0
:: Remove trailing backslash from TREND_VAULT_DIR
if "%TREND_VAULT_DIR:~-1%"=="\" set TREND_VAULT_DIR=%TREND_VAULT_DIR:~0,-1%

:: ── ElevenLabs key check (optional but recommended) ──────────
set ELEVENLABS_PRESENT=false
findstr /i /r "^ELEVENLABS_API_KEY=." "%TREND_VAULT_DIR%\.env" >nul 2>&1
if not errorlevel 1 set ELEVENLABS_PRESENT=true
:: ─────────────────────────────────────────────────────────────

echo.
echo ============================================================
echo   Trend Vault System Launcher
echo ============================================================
echo.
echo   Trend Vault        : %TREND_VAULT_DIR%
echo   ElevenLabs    : %ELEVENLABS_PRESENT%
echo.

:: ── STEP 1: Python check ─────────────────────────────────────
echo [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Python not found.
    echo Install Python 3.10+ from https://www.python.org/downloads/
    echo Check "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)
python --version
echo.

:: ── STEP 2: Node + node_modules check ────────────────────────
echo [2/4] Checking Node + npm packages...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js not found.
    echo Install Node 18+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
node --version
if not exist "%TREND_VAULT_DIR%\node_modules\remotion" (
    echo   node_modules missing or incomplete -- running npm install...
    pushd "%TREND_VAULT_DIR%"
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed. See output above.
        popd
        pause & exit /b 1
    )
    popd
) else (
    echo   node_modules OK.
)
echo.

:: ── STEP 3: Dependencies OK ───────────────────────────────────
echo [3/4] Dependencies... OK
echo.

:: ── STEP 4: Trend Vault Program (port 3001) ───────────────────────
echo [4/4] Trend Vault Program (port 3001)...
curl -s --max-time 2 http://localhost:3001 >nul 2>&1
if not errorlevel 1 goto :TREND_VAULT_ALREADY
echo   Clearing port 3001 (remove any zombie process)...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    if "%%P" neq "0" taskkill /F /PID %%P >nul 2>&1
)
set NODE_OPTIONS=--max-old-space-size=8192
echo   Node heap cap: %NODE_OPTIONS%
echo   Starting Trend Vault...
start "Trend Vault Web App" /D "%TREND_VAULT_DIR%" cmd /k "set NODE_OPTIONS=--max-old-space-size=8192 && npm start"
echo   Waiting for Trend Vault (up to 60s)...
set WAITED=0
:WAIT_TREND_VAULT
timeout /t 3 /nobreak >nul
set /a WAITED+=3
curl -s --max-time 2 http://localhost:3001 >nul 2>&1
if not errorlevel 1 goto :TREND_VAULT_READY
if %WAITED% lss 60 goto :WAIT_TREND_VAULT
echo   WARNING: Trend Vault slow to start -- check Trend Vault window.
goto :OPEN_BROWSER
:TREND_VAULT_ALREADY
echo   Already running.
goto :OPEN_BROWSER
:TREND_VAULT_READY
echo   Trend Vault is ready.

:OPEN_BROWSER
echo.
echo ============================================================
echo   All done!
echo   Trend Vault Studio : http://localhost:3001/trend-vault
echo ============================================================
echo.
echo   Opening browser...
start "" "http://localhost:3001/trend-vault"
echo.
echo   Keep the server window open.
echo   To stop: run stop_trend_vault_system.bat
echo.
pause
