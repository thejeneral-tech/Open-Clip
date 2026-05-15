@echo off
:: ============================================================================
::  START_ZODIAC_DAILY.bat
::  Daily launcher — opens every Zodiac service in its own titled window so
::  STOP_ZODIAC_SYSTEM.bat can find and close them. Reuses the heavy lifting in
::  start_zodiac_system.bat (Python/Node checks, venv build, etc.)
::  by simply launching it. The titles below are the canonical names that
::  STOP_ZODIAC_SYSTEM.bat targets — do not rename them without updating both.
:: ============================================================================

:: Keep window open after script ends (double-click runs cmd /c which closes).
if /i not "%~1"=="--keepopen" (
    start "Zodiac Daily Launcher" cmd /k call "%~f0" --keepopen
    exit /b 0
)
setlocal EnableDelayedExpansion
title Zodiac Daily Launcher
color 0A

set "ZODIAC_DIR=%~dp0"
if "%ZODIAC_DIR:~-1%"=="\" set "ZODIAC_DIR=%ZODIAC_DIR:~0,-1%"

echo.
echo ============================================================
echo   Zodiac Daily Launcher
echo ============================================================
echo.
echo   Project folder : %ZODIAC_DIR%
echo.
echo   This launcher delegates to start_zodiac_system.bat which:
echo     - checks Python/Node + installs missing deps
echo     - starts the Zodiac web app on port 3001
echo     - opens http://localhost:3001/zodiac in your browser
echo.
echo   Window titles used (target these from STOP_ZODIAC_SYSTEM.bat):
echo     - Zodiac Web App       (port 3001)
echo     - Zodiac Render Worker (Drive sync)  -- launch separately if needed
echo.
echo ============================================================
echo.

call "%ZODIAC_DIR%\start_zodiac_system.bat"

echo.
echo   Daily launcher complete. Use STOP_ZODIAC_SYSTEM.bat to stop everything.
echo.
pause
