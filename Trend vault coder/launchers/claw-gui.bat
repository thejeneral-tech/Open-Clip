@echo off
setlocal
cd /d "%~dp0\.."

REM Prefer the Windows Python launcher (py.exe) — it picks an installed Python 3.
where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3 "launchers\trendvault-gui.py" %*
  exit /b %ERRORLEVEL%
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python "launchers\trendvault-gui.py" %*
  exit /b %ERRORLEVEL%
)

echo.
echo  Python 3 is required but was not found on PATH.
echo  Install from https://www.python.org/downloads/ and try again.
echo.
pause
exit /b 1
