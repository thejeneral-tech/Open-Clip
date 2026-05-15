# ============================================================
# Trend Vault Program — Sync System Setup Script
# Run this ONCE on your HOME COMPUTER to create all folders.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/setup-sync.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# ── Load config ──────────────────────────────────────────────
$configPath = Join-Path $PSScriptRoot "..\sync.config.json"
if (-not (Test-Path $configPath)) {
    Write-Error "sync.config.json not found at: $configPath"
    exit 1
}
$config = Get-Content $configPath | ConvertFrom-Json

$localRoot  = $config.homeLocalRoot
$driveRoot  = $config.googleDriveRoot

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Trend Vault Program — Sync Folder Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Local root  : $localRoot" -ForegroundColor Yellow
Write-Host "  Drive root  : $driveRoot" -ForegroundColor Yellow
Write-Host ""

# ── Helper: create folder with message ───────────────────────
function Ensure-Folder {
    param([string]$Path, [string]$Label)
    if (Test-Path $Path) {
        Write-Host "  [EXISTS]  $Label" -ForegroundColor DarkGray
    } else {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        Write-Host "  [CREATED] $Label" -ForegroundColor Green
    }
}

# ── Local folders on home computer ───────────────────────────
Write-Host "Creating LOCAL folders on C: drive..." -ForegroundColor Cyan

Ensure-Folder "$localRoot"              "C:\Trend Vault Program"
Ensure-Folder "$localRoot\incoming"     "  incoming   (files arrive here first)"
Ensure-Folder "$localRoot\working"      "  working    (active processing)"
Ensure-Folder "$localRoot\cache"        "  cache      (local render cache — never synced)"
Ensure-Folder "$localRoot\renders"      "  renders    (intermediate render files)"
Ensure-Folder "$localRoot\final"        "  final      (completed outputs)"
Ensure-Folder "$localRoot\logs"         "  logs       (worker logs)"
Ensure-Folder "$localRoot\scripts"      "  scripts    (worker scripts live here too)"

# ── Google Drive folders (transfer bridge only) ───────────────
Write-Host ""
Write-Host "Creating GOOGLE DRIVE folders (transfer bridge)..." -ForegroundColor Cyan

if (-not (Test-Path $driveRoot)) {
    Write-Host ""
    Write-Host "  WARNING: Google Drive root does not exist:" -ForegroundColor Yellow
    Write-Host "  $driveRoot" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Please check your Google Drive path in sync.config.json" -ForegroundColor Yellow
    Write-Host "  Common paths:" -ForegroundColor White
    Write-Host "    C:\Users\$env:USERNAME\Google Drive\My Drive\Trend Vault Program Sync" -ForegroundColor White
    Write-Host "    G:\My Drive\Trend Vault Program Sync" -ForegroundColor White
    Write-Host ""
    $proceed = Read-Host "Create the folder anyway? (y/n)"
    if ($proceed -ne "y") {
        Write-Host "Skipped Google Drive folder creation. Edit sync.config.json and re-run." -ForegroundColor Red
        exit 0
    }
}

Ensure-Folder "$driveRoot"              "Trend Vault Program Sync"
Ensure-Folder "$driveRoot\requests"     "  requests   (laptop drops job JSON files here)"
Ensure-Folder "$driveRoot\uploads"      "  uploads    (laptop drops source files here)"
Ensure-Folder "$driveRoot\final"        "  final      (home computer delivers outputs here)"
Ensure-Folder "$driveRoot\logs"         "  logs       (important logs mirrored here)"

# ── .gitignore hint ──────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Copy the FULL Trend Vault Program project to this computer, then run: npm install" -ForegroundColor White
Write-Host "  2. Double-click START_RENDER_WORKER.bat  (or run: npm run sync:worker)" -ForegroundColor White
Write-Host "  3. Drop a job JSON into: $driveRoot\requests\" -ForegroundColor White
Write-Host ""
