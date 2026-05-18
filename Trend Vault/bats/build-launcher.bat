@echo off
:: Keep window open when double-clicked
if /i not "%~1"=="--keepopen" (
    start "Build Trend Vault Launcher" cmd /k call "%~f0" --keepopen
    exit /b 0
)

title Build Trend Vault Launcher

:: Project root is one level up from this bat file (bats/)
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

echo.
echo ============================================================
echo   Build Trend Vault Launcher
echo   Project root: %ROOT%
echo ============================================================
echo.

echo -- Checking for PyInstaller --------------------------------
python -m pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo Installing PyInstaller...
    python -m pip install pyinstaller
    if errorlevel 1 (
        echo ERROR: pip install pyinstaller failed.
        pause & exit /b 1
    )
)
echo [OK] PyInstaller found.
echo.

echo -- Building TrendVaultLauncher.exe -------------------------
python -m PyInstaller --onefile --windowed --name TrendVaultLauncher launcher.py
if errorlevel 1 (
    echo.
    echo ERROR: Build failed. Check the output above.
    pause & exit /b 1
)
echo.

echo -- Copying exe to project root -----------------------------
copy /Y "dist\TrendVaultLauncher.exe" "TrendVaultLauncher.exe" >nul
echo [OK] TrendVaultLauncher.exe is ready.

echo -- Cleaning up build artifacts -----------------------------
rmdir /S /Q build 2>nul
rmdir /S /Q dist  2>nul
del /Q TrendVaultLauncher.spec 2>nul

echo.
echo ============================================================
echo   Done! Double-click TrendVaultLauncher.exe to launch.
echo ============================================================
echo.
pause
