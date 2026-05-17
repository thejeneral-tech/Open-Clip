@echo off
:: ============================================================================
::  start-kokoro.bat
::  Activates the kokoro-tts venv and starts the Flask TTS server on :5070.
::  Run setup-kokoro.bat once before the first launch.
:: ============================================================================

setlocal
title Trend Vault Kokoro TTS (port 5070)
color 0A

pushd "%~dp0"
set "KOKORO_DIR=%CD%\kokoro-tts"
set "VENV_PY=%KOKORO_DIR%\.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo [error] venv not found at %VENV_PY%
    echo         Run setup-kokoro.bat first.
    popd & exit /b 1
)
if not exist "%KOKORO_DIR%\kokoro-v0_19.onnx" (
    echo [error] Model file missing. Run setup-kokoro.bat to download it.
    popd & exit /b 1
)

echo.
echo Starting Kokoro on http://127.0.0.1:5070
echo Press Ctrl+C to stop.
echo.

"%VENV_PY%" "%KOKORO_DIR%\kokoro_server.py"

popd
endlocal
