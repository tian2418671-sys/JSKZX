@echo off
title C Cleanup - DRY RUN
echo ============================================================
echo   C Cleanup - DRY RUN (nothing will be deleted)
echo   Details are printed below, in Chinese.
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin-clean.ps1"
echo.
pause
