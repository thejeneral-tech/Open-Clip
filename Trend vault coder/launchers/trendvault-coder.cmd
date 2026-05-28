@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%trendvault-coder-launcher.js" %*
exit /b %ERRORLEVEL%
