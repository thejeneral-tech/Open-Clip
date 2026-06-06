# launch-windows.ps1 — bootstrap + run TrendVault Studio V2.0 (FastAPI) on Windows.
#   - finds Python 3.11+, builds ./venv, installs requirements
#   - runs `npm install` for the Remotion render pipeline (if npm is present)
#   - starts uvicorn on port 3001 (single worker — required for the SSE registry)
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
#         powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1 -Port 3001
param(
    [int]$Port = 3001,
    [string]$BindHost = "127.0.0.1"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-PythonExe {
    foreach ($c in @("python", "python3")) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) {
            $ver = & $cmd.Source --version 2>&1
            if ($ver -match "Python 3\.(1[1-9]|[2-9]\d)") { return $cmd.Source }
        }
    }
    foreach ($v in @("3.13", "3.12", "3.11")) {
        try {
            $p = & py -$v -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
        } catch {}
    }
    throw "Python 3.11+ not found. Install it from https://www.python.org/downloads/"
}

Write-Host "==> Locating Python 3.11+..."
$pythonExe = Find-PythonExe
Write-Host "    using: $pythonExe"

if (-not (Test-Path "venv")) {
    Write-Host "==> Creating virtual environment (./venv)..."
    & $pythonExe -m venv venv
}
$venvPy = Join-Path $PSScriptRoot "venv\Scripts\python.exe"

Write-Host "==> Installing Python dependencies..."
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r requirements.txt

if (Get-Command npm -ErrorAction SilentlyContinue) {
    if (-not (Test-Path "node_modules")) {
        Write-Host "==> Installing Remotion render deps (npm install)..."
        npm install --no-audit --no-fund
    }
} else {
    Write-Host "WARNING: npm not found. Video rendering needs Node.js + 'npm install' in this folder." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==> Starting TrendVault Studio  ->  http://$BindHost`:$Port/trend-vault" -ForegroundColor Green
Write-Host "    (Kokoro TTS must be running on port 5070 for voice/render)"
Write-Host ""
& $venvPy -m uvicorn app:app --host $BindHost --port $Port
