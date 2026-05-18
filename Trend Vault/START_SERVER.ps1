# ─────────────────────────────────────────────────────────────
#  Trend Vault — Start Server
#  Run from anywhere:
#    powershell -ExecutionPolicy Bypass -File "C:\Users\Anton\OneDrive\Documents\GitHub\TrendVault-Program\Trend Vault\START_SERVER.ps1"
# ─────────────────────────────────────────────────────────────

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║      Trend Vault Studio — Start      ║" -ForegroundColor Magenta
Write-Host "  ╚══════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Directory: $ProjectDir" -ForegroundColor DarkGray
Write-Host ""

# ── Kill anything already on port 3000 ────────────────────────
$existing = netstat -ano | Select-String ":3000 " | Select-String "LISTENING"
if ($existing) {
    $pid3000 = ($existing -split '\s+')[-1]
    Write-Host "  ⚠ Port 3000 in use (PID $pid3000) — stopping it..." -ForegroundColor Yellow
    try { Stop-Process -Id $pid3000 -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 1
    Write-Host "  ✓ Cleared" -ForegroundColor Green
}

# ── Check node_modules ─────────────────────────────────────────
if (-not (Test-Path "$ProjectDir\node_modules")) {
    Write-Host "  📦 node_modules missing — running npm install..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# ── Check .env ─────────────────────────────────────────────────
if (-not (Test-Path "$ProjectDir\.env")) {
    Write-Host "  ⚠  No .env file found — server will start but AI features may not work." -ForegroundColor Yellow
    Write-Host ""
}

# ── Start ──────────────────────────────────────────────────────
Write-Host "  🚀 Starting Trend Vault server..." -ForegroundColor Cyan
Write-Host "  🌐 Open: http://localhost:3000/trend-vault" -ForegroundColor Green
Write-Host "  📋 Mainframe: http://localhost:3000/mainframe" -ForegroundColor Green
Write-Host "  👥 Accounts:  http://localhost:3000/accounts" -ForegroundColor Green
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

npx tsx server.ts
