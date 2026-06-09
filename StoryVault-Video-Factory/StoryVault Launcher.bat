@echo off
REM Double-click to open the StoryVault Video Factory launcher (Install / Start / Stop).
REM The PowerShell GUI hides this console window automatically.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
