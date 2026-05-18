@echo off
REM ============================================================
REM  Ollama Chat - Windows launcher
REM  Starts the Node web server and opens the UI in your browser.
REM ============================================================

setlocal

REM cd to the folder this .bat file lives in, so it works no matter
REM where it's launched from (double-clicked, shortcut, etc.).
cd /d "%~dp0"

REM Allow overriding the port: `start-server.bat 8080`
set "PORT=%~1"
if "%PORT%"=="" set "PORT=5500"

REM Make sure Node is installed.
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [!] Node.js was not found on your PATH.
    echo      Install it from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

REM Make sure server.js is here.
if not exist "%~dp0server.js" (
    echo.
    echo  [!] server.js not found in "%~dp0"
    echo.
    pause
    exit /b 1
)

echo.
echo  Starting Ollama Chat on http://localhost:%PORT%
echo  Press Ctrl+C in this window to stop.
echo.

REM Open the browser after a short delay so the server has time to bind.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"

REM Run the server in the foreground. Ctrl+C in this window stops it.
node server.js

REM If node exits unexpectedly, keep the window open so you can read the error.
echo.
echo  Server stopped.
pause
endlocal
