@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%claude-gemini-launcher.cjs" %*
exit /b %ERRORLEVEL%
