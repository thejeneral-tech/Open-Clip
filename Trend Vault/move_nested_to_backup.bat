@echo off
setlocal

set "SRC=C:\Users\Anton\OneDrive\Desktop\Zodiac Program\Zodiac Program"
set "DST=C:\Users\Anton\OneDrive\Desktop\Zodiac_Program_BACKUP_2026-05-10"

echo.
echo === Zodiac Program: move nested duplicate to backup ===
echo.
echo Source : %SRC%
echo Target : %DST%
echo.

if not exist "%SRC%" (
    echo Source folder not found. Nothing to move.
    pause
    exit /b 0
)

if exist "%DST%" (
    echo ERROR: target folder already exists:
    echo   %DST%
    echo Rename or remove it first, then re-run this script.
    pause
    exit /b 1
)

echo Moving... (same-drive rename, should be near-instant)
move "%SRC%" "%DST%"

if errorlevel 1 (
    echo.
    echo Move FAILED. The source folder is still where it was.
    echo Most common cause: a file inside is open in an editor or terminal. Close it and retry.
    pause
    exit /b 1
)

echo.
echo Done.
echo The duplicate has been moved to:
echo   %DST%
echo.
echo Your live project remains at:
echo   C:\Users\Anton\OneDrive\Desktop\Zodiac Program
echo.
pause
endlocal
