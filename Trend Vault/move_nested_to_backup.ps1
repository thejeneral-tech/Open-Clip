# move_nested_to_backup.ps1
# Moves the duplicate nested "Zodiac Program" folder out of the live project
# and renames it as a dated backup sitting beside it on the Desktop.
#
# Source : C:\Users\Anton\OneDrive\Desktop\Zodiac Program\Zodiac Program\
# Target : C:\Users\Anton\OneDrive\Desktop\Zodiac_Program_BACKUP_2026-05-10\
#
# Run it by right-clicking this file -> "Run with PowerShell",
# OR open PowerShell and run:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Anton\OneDrive\Desktop\Zodiac Program\move_nested_to_backup.ps1"

$ErrorActionPreference = 'Stop'

$source = 'C:\Users\Anton\OneDrive\Desktop\Zodiac Program\Zodiac Program'
$target = 'C:\Users\Anton\OneDrive\Desktop\Zodiac_Program_BACKUP_2026-05-10'

Write-Host ""
Write-Host "=== Zodiac Program: move nested duplicate to backup ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source : $source"
Write-Host "Target : $target"
Write-Host ""

if (-not (Test-Path -LiteralPath $source)) {
    Write-Host "Source folder not found. Nothing to move." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 0
}

if (Test-Path -LiteralPath $target) {
    Write-Host "ERROR: target folder already exists:" -ForegroundColor Red
    Write-Host "  $target"
    Write-Host "Rename or remove it first, then re-run this script."
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Moving... (this is a same-drive rename, should be near-instant)" -ForegroundColor Cyan
Move-Item -LiteralPath $source -Destination $target -Force

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "The duplicate has been moved to:" -ForegroundColor Green
Write-Host "  $target"
Write-Host ""
Write-Host "Your live project remains at:" -ForegroundColor Green
Write-Host "  C:\Users\Anton\OneDrive\Desktop\Zodiac Program"
Write-Host ""
Write-Host "If everything looks good after a few days, you can delete the BACKUP folder to free disk space."
Write-Host ""
Read-Host "Press Enter to close"
