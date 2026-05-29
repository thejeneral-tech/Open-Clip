@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%trendvault-coder-launcher.cjs" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo TrendVault Coder exited with code %RC%.
  echo Scroll up for details.
  pause
)
exit /b %RC%
