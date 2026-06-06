@echo off
:: ============================================================================
::  setup-kokoro.bat
::  Creates the Python venv, installs kokoro-onnx + Flask, and downloads the
::  Kokoro v0.19 ONNX model + voices. Safe to re-run; reuses anything already
::  in place.
::
::  After this finishes once, just use bats\start-kokoro.bat to boot the server.
:: ============================================================================

setlocal EnableDelayedExpansion
title Trend Vault — Kokoro Setup
color 0B

pushd "%~dp0.."
set "TV_DIR=%CD%"
set "KOKORO_DIR=%TV_DIR%\kokoro-tts"
set "VENV_DIR=%KOKORO_DIR%\.venv"
set "MODEL=%KOKORO_DIR%\kokoro-v0_19.onnx"
set "VOICES=%KOKORO_DIR%\voices.bin"

echo.
echo ============================================================
echo   Kokoro TTS setup
echo   Target: %KOKORO_DIR%
echo ============================================================
echo.

if not exist "%KOKORO_DIR%" (
    echo [setup] Creating %KOKORO_DIR%
    mkdir "%KOKORO_DIR%"
)

:: ── Locate Python ────────────────────────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo [error] Python is not on PATH. Install Python 3.10+ from python.org first.
    popd & exit /b 1
)

:: ── Create venv ──────────────────────────────────────────────────────────────
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [setup] Creating virtualenv at %VENV_DIR%
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [error] venv creation failed.
        popd & exit /b 1
    )
) else (
    echo [setup] venv already exists, reusing.
)

set "PY=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"

:: ── Install deps ─────────────────────────────────────────────────────────────
echo [setup] Upgrading pip
"%PY%" -m pip install --upgrade pip --disable-pip-version-check

echo [setup] Installing requirements
"%PIP%" install -r "%KOKORO_DIR%\requirements.txt"
if errorlevel 1 (
    echo [error] pip install failed.
    popd & exit /b 1
)

:: ── Download model files ─────────────────────────────────────────────────────
if not exist "%MODEL%" (
    echo [setup] Downloading kokoro-v0_19.onnx ^(~80 MB^)
    "%PY%" -c "import urllib.request,sys; urllib.request.urlretrieve('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx', r'%MODEL%')"
    if errorlevel 1 (
        echo [error] model download failed. You can manually grab it from
        echo         https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files
        echo         and drop it at %MODEL%
        popd & exit /b 1
    )
) else (
    echo [setup] Model already present, skipping.
)

if not exist "%VOICES%" (
    echo [setup] Downloading voices.bin
    "%PY%" -c "import urllib.request,sys; urllib.request.urlretrieve('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices.bin', r'%VOICES%')"
    if errorlevel 1 (
        echo [error] voices download failed. Grab manually from the same release.
        popd & exit /b 1
    )
) else (
    echo [setup] voices.bin already present, skipping.
)

echo.
echo ============================================================
echo   Kokoro setup complete.
echo   Start the server with: bats\start-kokoro.bat
echo ============================================================
echo.
popd
endlocal
