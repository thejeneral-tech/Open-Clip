@echo off
title YouTube Video Intelligence Agent
cd /d "%~dp0"

REM ---- Run the whole agent on port 6113 ----
set YIA_PORT=6113

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH. Install Python 3.10+ and try again.
  pause
  exit /b 1
)

REM The starter verifies dependencies, Ollama, the model, ffmpeg and the port,
REM fixes what it can automatically, then launches the server.
python starter.py

echo.
echo Server stopped.
pause
