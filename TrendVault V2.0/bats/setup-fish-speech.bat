@echo off
:: ============================================================================
::  setup-fish-speech.bat
::  One-time setup for the Fish Speech S2 Pro runtime.
::
::  Paths used (overridable via environment variables):
::    Runtime:  %LOCALAPPDATA%\trendvault\runtimes\fish-speech  (FISH_SPEECH_RUNTIME_PATH)
::    Venv:     <runtime>\.venv                                 (FISH_SPEECH_VENV_PATH)
::    Model:    C:\Users\%USERNAME%\s2-pro                      (FISH_S2_PRO_MODEL_PATH)
::
::  After this completes you can start the server with:
::    bats\start-fish-speech.bat
::  OR just press ▶ on the Fish Speech card in the launcher.
:: ============================================================================

setlocal enabledelayedexpansion
title Trend Vault -- Fish Speech S2 Pro Setup
color 0E

:: ── Resolve paths (env vars take precedence) ────────────────────────────────
if "%FISH_SPEECH_RUNTIME_PATH%"=="" (
    set "FISH_RUNTIME=%LOCALAPPDATA%\trendvault\runtimes\fish-speech"
) else (
    set "FISH_RUNTIME=%FISH_SPEECH_RUNTIME_PATH%"
)

if "%FISH_SPEECH_VENV_PATH%"=="" (
    set "FISH_VENV=%FISH_RUNTIME%\.venv"
) else (
    set "FISH_VENV=%FISH_SPEECH_VENV_PATH%"
)

if "%FISH_S2_PRO_MODEL_PATH%"=="" (
    set "FISH_MODEL=%USERPROFILE%\s2-pro"
) else (
    set "FISH_MODEL=%FISH_S2_PRO_MODEL_PATH%"
)

echo.
echo [setup] Fish Speech S2 Pro — Runtime Setup
echo [setup] Runtime path : %FISH_RUNTIME%
echo [setup] Venv path    : %FISH_VENV%
echo [setup] Model path   : %FISH_MODEL%
echo.

:: ── Step 1: Clone the fish-speech repo ──────────────────────────────────────
if exist "%FISH_RUNTIME%\tools\api_server.py" (
    echo [setup] Fish-speech runtime already cloned — skipping.
) else (
    echo [setup] Cloning fish-speech runtime from GitHub...
    echo [setup] Target: %FISH_RUNTIME%
    echo.

    :: Ensure parent directory exists
    if not exist "%LOCALAPPDATA%\trendvault\runtimes" (
        mkdir "%LOCALAPPDATA%\trendvault\runtimes"
    )

    git --version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] git not found on PATH.
        echo         Install Git for Windows: https://git-scm.com/download/win
        echo         Then re-run this script.
        pause & exit /b 1
    )

    git clone --depth 1 https://github.com/fishaudio/fish-speech.git "%FISH_RUNTIME%"
    if errorlevel 1 (
        echo [ERROR] git clone failed. Check your internet connection and try again.
        pause & exit /b 1
    )
    echo [setup] Runtime cloned successfully.
)

:: -- Step 2: Locate Python 3.10 or 3.11 (PREFER 3.11) ------------------------
:: Fish Speech REQUIRES Python 3.10 or 3.11. 3.12, 3.13, and 3.14 are rejected
:: because torch==2.8.0 (and other pinned wheels) are not built for those.
echo [setup] Detecting installed Python interpreters via the 'py' launcher...

set "FISH_PY="
set "FISH_PY_VER="

:: Probe 3.11 first (preferred).
py -3.11 -c "import sys;print(sys.executable)" >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%P in ('py -3.11 -c "import sys;print(sys.executable)"') do set "FISH_PY=%%P"
    set "FISH_PY_VER=3.11"
    set "FISH_PY_LAUNCH=py -3.11"
    echo [setup]   [OK]  Python 3.11 detected: !FISH_PY!
) else (
    echo [setup]   [miss] Python 3.11 not found via 'py -3.11'
)

:: If 3.11 was not found, fall back to 3.10.
if "%FISH_PY_VER%"=="" (
    py -3.10 -c "import sys;print(sys.executable)" >nul 2>&1
    if not errorlevel 1 (
        for /f "tokens=*" %%P in ('py -3.10 -c "import sys;print(sys.executable)"') do set "FISH_PY=%%P"
        set "FISH_PY_VER=3.10"
        set "FISH_PY_LAUNCH=py -3.10"
        echo [setup]   [OK]  Python 3.10 detected: !FISH_PY!
    ) else (
        echo [setup]   [miss] Python 3.10 not found via 'py -3.10'
    )
)

:: Log any incompatible Pythons we did find, for clarity.
for %%V in (3.12 3.13 3.14) do (
    py -%%V -c "import sys;print(sys.executable)" >nul 2>&1
    if not errorlevel 1 (
        echo [setup]   [skip] Python %%V is installed but NOT supported by Fish Speech.
    )
)

if "%FISH_PY_VER%"=="" (
    echo.
    echo Fish Speech requires Python 3.10 or 3.11. Install Python 3.11 from python.org, then retry.
    echo.
    pause & exit /b 1
)

echo [setup] Selected Python: %FISH_PY_VER%  (%FISH_PY%)
echo [setup] Launcher command: %FISH_PY_LAUNCH%

:: -- Step 2b: If an existing venv is broken (built with 3.12+), nuke it -----
if exist "%FISH_VENV%\Scripts\python.exe" (
    for /f "tokens=*" %%V in ('"%FISH_VENV%\Scripts\python.exe" -c "import sys;print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2^>nul') do set "EXISTING_VER=%%V"
    echo [setup] Existing venv uses Python !EXISTING_VER!
    if not "!EXISTING_VER!"=="3.11" if not "!EXISTING_VER!"=="3.10" (
        echo [setup] Existing venv is INCOMPATIBLE -- deleting %FISH_VENV%
        rmdir /s /q "%FISH_VENV%"
    )
)

:: -- Step 2c: Create Python venv with the selected interpreter --------------
if exist "%FISH_VENV%\Scripts\python.exe" (
    echo [setup] Venv already exists and is compatible -- skipping creation.
) else (
    echo [setup] Creating Python venv at %FISH_VENV% using %FISH_PY_LAUNCH%...
    %FISH_PY_LAUNCH% -m venv "%FISH_VENV%"
    if errorlevel 1 (
        echo [ERROR] Could not create venv with %FISH_PY_LAUNCH%.
        echo         Ensure Python 3.11 is installed and on PATH.
        echo         Download: https://www.python.org/downloads/
        pause & exit /b 1
    )
    for /f "tokens=*" %%V in ('"%FISH_VENV%\Scripts\python.exe" -c "import sys;print(f'{sys.version_info[0]}.{sys.version_info[1]}')"') do set "NEW_VER=%%V"
    echo [setup] Venv Python version: !NEW_VER!
    echo [setup] Venv created.
)

:: ── Step 3: Upgrade pip ──────────────────────────────────────────────────────
echo [setup] Upgrading pip...
"%FISH_VENV%\Scripts\python.exe" -m pip install --upgrade pip --quiet

:: ── Step 4a: Patch pyproject.toml — relax impossible torch/numpy/Python pins ──
:: fish-speech sometimes pins torch==X.Y.Z to a version that doesn't exist on
:: PyPI yet. We relax those constraints so pip can install the latest available.
echo [setup] Patching pyproject.toml constraints...
"%FISH_VENV%\Scripts\python.exe" -c ^
"import re, sys; p=open('pyproject.toml','r',encoding='utf-8').read(); ^
 t=re.sub(r'\"torch==[\d.]+\"','\"torch>=2.0.0,<4.0.0\"',p); ^
 t=re.sub(r'\"torchaudio==[\d.]+\"','\"torchaudio>=2.0.0,<4.0.0\"',t); ^
 t=re.sub(r'\"numpy([^\"]*),<[\d.]+\"',r'\"numpy\1\"',t); ^
 t=re.sub(r'requires-python\s*=\s*\"([^\"]*)\"', ^
          lambda m: 'requires-python = \"' + re.sub(r',<3\.\d+','',m.group(1)) + '\"', t); ^
 open('pyproject.toml','w',encoding='utf-8').write(t); ^
 print('[setup] pyproject.toml patched OK') if t!=p else print('[setup] pyproject.toml already flexible')"
:: (ignore errors here — main install will also patch via fish_speech_server.py)

:: ── Step 4b: Pre-install PyTorch (no version pin) ─────────────────────────────
echo [setup] Installing PyTorch (latest compatible — this may take a few minutes)...
"%FISH_VENV%\Scripts\python.exe" -m pip install torch torchaudio --quiet --disable-pip-version-check

:: ── Step 4c: Install fish-speech + remaining dependencies ────────────────────
echo [setup] Installing fish-speech (pip install -e .)
echo [setup] This can take 5-15 minutes on first run...
echo.

"%FISH_VENV%\Scripts\python.exe" -m pip install -e . --disable-pip-version-check
if errorlevel 1 (
    echo [warn]  Standard install had issues — retrying with --no-build-isolation...
    "%FISH_VENV%\Scripts\python.exe" -m pip install -e . --no-build-isolation --disable-pip-version-check
    if errorlevel 1 (
        echo [ERROR] pip install failed. See messages above.
        echo.
        echo [HINT]  Common fixes:
        echo           - Use Python 3.10 or 3.11 ONLY (NOT 3.12, 3.13, or 3.14)
        echo           - If wrong Python: install 3.11 from python.org, delete
        echo             "%FISH_VENV%" and re-run this script
        echo           - Ensure internet access (PyPI + GitHub reachable)
        echo           - Run: bats\setup-fish-speech.bat  after fixing the above
        pause & exit /b 1
    )
)

:: ── Step 5: Check model ───────────────────────────────────────────────────────
echo.
if exist "%FISH_MODEL%\config.json" (
    echo [setup] Model found at: %FISH_MODEL%
) else if exist "%FISH_MODEL%\model.pth" (
    echo [setup] Model found at: %FISH_MODEL%
) else (
    echo [warn]  Model not found at: %FISH_MODEL%
    echo         Your model is at C:\Users\Anton\s2-pro -- that path is already
    echo         configured in .env.all as FISH_S2_PRO_MODEL_PATH.
    echo         If the path is different, update FISH_S2_PRO_MODEL_PATH in .env.all
)

echo.
echo [setup] ================================================================
echo [setup]  Fish Speech S2 Pro runtime installed successfully!
echo [setup] ================================================================
echo.
echo [setup] Next steps:
echo [setup]   1. Start the server:  bats\start-fish-speech.bat
echo [setup]   2. Or click the Fish Speech card in the Trend Vault launcher
echo [setup]   3. Then use any Fish voice in Voice Lab or Trend Vault Studio
echo.
pause
popd
endlocal
