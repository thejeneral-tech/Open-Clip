@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%claw-dev-launcher.js" %*
exit /b %ERRORLEVEL%
