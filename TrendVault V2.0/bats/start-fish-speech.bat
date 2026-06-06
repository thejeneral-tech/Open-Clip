@echo off
:: ============================================================================
::  start-fish-speech.bat
::  Starts the Fish Speech S2 Pro server on http://127.0.0.1:8080.
::
::  Uses the self-contained fish_speech_server.py launcher which handles
::  first-time setup automatically (git clone, venv, pip install).
::
::  Paths (all overridable via env vars):
::    Model:   FISH_S2_PRO_MODEL_PATH  (default: %USERPROFILE%\s2-pro)
::    Runtime: FISH_SPEECH_RUNTIME_PATH (default: %LOCALAPPDATA%\trendvault\runtimes\fish-speech)
::    Venv:    FISH_SPEECH_VENV_PATH    (default: <runtime>\.venv)
::    URL:     FISH_TTS_URL             (default: http://127.0.0.1:8080)
:: ============================================================================

setlocal
title Trend Vault — Fish Speech S2 Pro (port 8080)
color 0A

pushd "%~dp0.."

:: ── Load .env.all if present ─────────────────────────────────────────────────
if exist ".env.all" (
    for /f "usebackq tokens=1,2 delims==" %%A in (".env.all") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" (
            if "%%B" neq "" set "%%A=%%B"
        )
    )
)

:: ── Default paths ────────────────────────────────────────────────────────────
if "%FISH_S2_PRO_MODEL_PATH%"==""    set "FISH_S2_PRO_MODEL_PATH=%USERPROFILE%\s2-pro"
if "%FISH_SPEECH_RUNTIME_PATH%"==""  set "FISH_SPEECH_RUNTIME_PATH=%LOCALAPPDATA%\trendvault\runtimes\fish-speech"
if "%FISH_SPEECH_VENV_PATH%"==""     set "FISH_SPEECH_VENV_PATH=%FISH_SPEECH_RUNTIME_PATH%\.venv"
if "%FISH_TTS_URL%"==""              set "FISH_TTS_URL=http://127.0.0.1:8080"

echo.
echo [Fish Speech] Starting Fish Speech S2 Pro server
echo [Fish Speech] Model:   %FISH_S2_PRO_MODEL_PATH%
echo [Fish Speech] Runtime: %FISH_SPEECH_RUNTIME_PATH%
echo [Fish Speech] Venv:    %FISH_SPEECH_VENV_PATH%
echo [Fish Speech] URL:     %FISH_TTS_URL%
echo.

:: ── Strategy 1: Use fish_speech_server.py (preferred — handles full setup) ───
set "LAUNCHER=%~dp0..\fish_speech_server.py"
if exist "%LAUNCHER%" (
    :: Try the venv python first (fastest), fall back to system python
    set "VENV_PY=%FISH_SPEECH_VENV_PATH%\Scripts\python.exe"
    if exist "%VENV_PY%" (
        echo [Fish Speech] Using venv: %VENV_PY%
        "%VENV_PY%" "%LAUNCHER%"
        goto :eof
    )
    :: System python — will create venv during setup
    python "%LAUNCHER%"
    goto :done
)

:: ── Strategy 2: Direct tools.api_server call (venv must already exist) ────────
set "VENV_PY=%FISH_SPEECH_VENV_PATH%\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [ERROR] Fish Speech venv not found at:
    echo         %FISH_SPEECH_VENV_PATH%
    echo.
    echo Run bats\setup-fish-speech.bat first to build the runtime.
    echo.
    pause
    popd & exit /b 1
)

echo [Fish Speech] Starting via tools.api_server...
"%VENV_PY%" -m tools.api_server ^
    --listen 127.0.0.1:8080 ^
    --llama-checkpoint-path "%FISH_S2_PRO_MODEL_PATH%"

:done
popd
endlocal
