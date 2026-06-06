@echo off
title YouTube Video Intelligence Agent - Installer
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH.
  echo Install Python 3.10+ from https://www.python.org/downloads/ ^(check "Add to PATH"^), then re-run this.
  pause
  exit /b 1
)

echo ============================================================
echo   YouTube Video Intelligence Agent - first-run installer
echo   This downloads all dependencies and AI models.
echo   It can take a while and several GB on the first run.
echo ============================================================
echo.

REM Pass through optional flags, e.g.  install.bat --vision
python install.py %*

REM install.py pauses on its own; this is a safety net.
if errorlevel 1 pause
