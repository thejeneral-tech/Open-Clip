@echo off
:: Launch the TrendVault Launcher GUI (no console window).
:: Uses pythonw if available so no extra terminal lingers.
title TrendVault Launcher
cd /d "%~dp0.."

where pythonw >nul 2>&1 && (start "" pythonw launcher.py & exit /b)
where py      >nul 2>&1 && (start "" py launcher.py      & exit /b)
start "" python launcher.py
