@echo off
setlocal
cd /d "%~dp0\.."

if not defined WEB_PORT set "WEB_PORT=7878"
set "URL=http://127.0.0.1:%WEB_PORT%"

echo.
echo  TrendVault Coder Web UI
echo  ---------------
echo  URL: %URL%
echo  Press Ctrl+C in this window to stop the server.
echo.

if not exist "node_modules" (
  echo  Dependencies missing - running npm install...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed. See output above.
    exit /b 1
  )
  echo.
)

REM Kill any stale server still holding the port so we don't crash with EADDRINUSE.
REM PowerShell is the most reliable way to do this on Windows.
powershell -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort %WEB_PORT% -State Listen -ErrorAction SilentlyContinue; if ($conn) { Write-Host '  Found existing server on port %WEB_PORT% (PID' $conn.OwningProcess '), stopping it...'; Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600 }"

REM Open the browser after a short delay so the server has time to bind.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

call npm run web

endlocal
