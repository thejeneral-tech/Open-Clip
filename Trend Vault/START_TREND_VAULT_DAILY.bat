@echo off
:: ============================================================================
::  START_TREND_VAULT_DAILY.bat
::  Daily launcher — opens every Trend Vault service in its own titled window so
::  STOP_TREND_VAULT_SYSTEM.bat can find and close them. Reuses the heavy lifting in
::  start_trend_vault_system.bat (Python/Node checks, venv build, etc.)
::  by simply launching it. The titles below are the canonical names that
::  STOP_TREND_VAULT_SYSTEM.bat targets — do not rename them without updating both.
:: ============================================================================

:: Keep window open after script ends (double-click runs cmd /c which closes).
if /i not "%~1"=="--keepopen" (
    start "Trend Vault Daily Launcher" cmd /k call "%~f0" --keepopen
    exit /b 0
)
setlocal EnableDelayedExpansion
title Trend Vault Daily Launcher
color 0A

set "TREND_VAULT_DIR=%~dp0"
if "%TREND_VAULT_DIR:~-1%"=="\" set "TREND_VAULT_DIR=%TREND_VAULT_DIR:~0,-1%"

echo.
echo ============================================================
echo   Trend Vault Daily Launcher
echo ============================================================
echo.
echo   Project folder : %TREND_VAULT_DIR%
echo.
echo   This launcher delegates to start_trend_vault_system.bat which:
echo     - checks Python/Node + installs missing deps
echo     - starts the Trend Vault web app on port 3001
echo     - opens http://localhost:3001/trend-vault in your browser
echo.
echo   Window titles used (target these from STOP_TREND_VAULT_SYSTEM.bat):
echo     - Trend Vault Web App       (port 3001)
echo     - Trend Vault Render Worker (Drive sync)  -- launch separately if needed
echo.
echo ============================================================
echo.

call "%TREND_VAULT_DIR%\start_trend_vault_system.bat"

echo.
echo   Daily launcher complete. Use STOP_TREND_VAULT_SYSTEM.bat to stop everything.
echo.
pause
