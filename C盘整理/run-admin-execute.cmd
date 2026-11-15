@echo off
title C Cleanup - EXECUTE
echo ============================================================
echo   C Cleanup - EXECUTE MODE
echo   Deletes: crash dumps / installer caches / 82 old driver packs
echo   Each INF keeps only the newest version; in-use ones are skipped.
echo ------------------------------------------------------------
echo   A UAC prompt will appear. Click "Yes".
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin-clean.ps1" -Execute
echo.
pause
