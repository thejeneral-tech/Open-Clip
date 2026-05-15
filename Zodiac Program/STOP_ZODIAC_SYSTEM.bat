@echo off
:: ============================================================================
::  STOP_ZODIAC_SYSTEM.bat
::  Safely stops every process started by START_ZODIAC_DAILY.bat /
::  start_zodiac_system.bat. Targets by:
::   1) titled console window names (set in start_*.bat)
::   2) the specific TCP ports the Zodiac services bind to
::   3) the Zodiac project folder (so unrelated node.exe processes are spared)
::  It is safe to run multiple times — already-stopped services just print
::  "Already stopped".
:: ============================================================================

setlocal EnableDelayedExpansion
title Zodiac System Stop
color 0C

echo.
echo ============================================================
echo   Stopping all Zodiac services...
echo ============================================================
echo.

set "ZODIAC_DIR=%~dp0"
if "%ZODIAC_DIR:~-1%"=="\" set "ZODIAC_DIR=%ZODIAC_DIR:~0,-1%"

set "STOPPED_ANY=0"

:: ── 1. Web App (port 3001) ─────────────────────────────────────────────────
echo   Closing Zodiac Web App (port 3001)...
set "PIDFOUND="
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3001 " ^| findstr "LISTENING"') do (
    if "%%P" neq "0" (
        taskkill /F /PID %%P >nul 2>&1
        set "PIDFOUND=%%P"
        set "STOPPED_ANY=1"
    )
)
if defined PIDFOUND ( echo     stopped PID !PIDFOUND! ) else ( echo     Already stopped )

:: ── 2. Fish Speech Bridge (port 5080) ──────────────────────────────────────
echo   Closing Zodiac Fish Bridge (port 5080)...
set "PIDFOUND="
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":5080 " ^| findstr "LISTENING"') do (
    if "%%P" neq "0" (
        taskkill /F /PID %%P >nul 2>&1
        set "PIDFOUND=%%P"
        set "STOPPED_ANY=1"
    )
)
if defined PIDFOUND ( echo     stopped PID !PIDFOUND! ) else ( echo     Already stopped )

:: ── 3. Fish Speech API (port 8080) ─────────────────────────────────────────
echo   Closing Zodiac Fish Speech API (port 8080)...
set "PIDFOUND="
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":8080 " ^| findstr "LISTENING"') do (
    if "%%P" neq "0" (
        taskkill /F /PID %%P >nul 2>&1
        set "PIDFOUND=%%P"
        set "STOPPED_ANY=1"
    )
)
if defined PIDFOUND ( echo     stopped PID !PIDFOUND! ) else ( echo     Already stopped )

:: ── 4. Render worker (no fixed port — kill by title only) ─────────────────
echo   Closing Zodiac Render Worker (if running)...
tasklist /FI "WINDOWTITLE eq Zodiac Render Worker" 2>nul | findstr /I "cmd" >nul
if not errorlevel 1 (
    taskkill /FI "WINDOWTITLE eq Zodiac Render Worker" /F >nul 2>&1
    echo     closed
    set "STOPPED_ANY=1"
) else (
    echo     Already stopped
)

echo.
echo   Closing titled console windows...

:: ── 5. Close the console windows themselves (titles set by start_*.bat) ───
:: Older title forms are included so we sweep up legacy launches too.
:: We tolerate not-found errors silently because tasks may already be gone.
for %%T in (
    "Zodiac Web App"
    "Zodiac Fish Bridge"
    "Zodiac Fish Speech API"
    "Zodiac Render Worker"
    "Zodiac Daily Launcher"
    "Zodiac System Launcher"
    "Zodiac System Stop"
    "Zodiac Program :3001"
    "Fish Speech Bridge :5080"
    "Fish Speech API :8080"
    "Fish Speech API"
    "Fish Speech Bridge (port 5080)"
    "Fish Speech API (port 8080)"
    "Kokoro TTS"
) do (
    taskkill /FI "WINDOWTITLE eq %%~T" /F >nul 2>&1
)

:: ── 6. Stop orphaned node/python processes ONLY if launched from this folder
:: This safely avoids killing unrelated Node apps the user has open. We match
:: on the command line containing the Zodiac project path.
echo.
echo   Scanning for orphaned Zodiac node/python processes in:
echo   %ZODIAC_DIR%
for /f "tokens=2 delims=," %%P in ('wmic process where "Name='node.exe' or Name='python.exe' or Name='tsx.exe'" get ProcessId^,CommandLine /format:csv 2^>nul ^| findstr /I /C:"%ZODIAC_DIR%"') do (
    taskkill /F /PID %%P >nul 2>&1
)

echo.
echo ============================================================
if "%STOPPED_ANY%"=="1" (
    echo   Zodiac system stopped.
) else (
    echo   Nothing was running. Already stopped.
)
echo ============================================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0
