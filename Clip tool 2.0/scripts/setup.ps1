# OpenClip local setup (Windows / PowerShell) — no Docker.
# Creates the backend virtualenv, installs dependencies, and initializes the DB.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "OpenClip local setup" -ForegroundColor Cyan

$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" }
      elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
      else { Write-Error "Python 3.10-3.12 is required. https://www.python.org/downloads/" }

& $py launch.py setup
if ($LASTEXITCODE -ne 0) { Write-Error "Setup failed." }

Write-Host ""
Write-Host "Done. Start everything with:  $py launch.py up" -ForegroundColor Green
