@echo off
REM ============================================================
REM  WINDOWS ONLY — updater for the HTML -> Figma Importer
REM ============================================================
REM  Double-click this file to update this folder to the latest version.
REM  (macOS users: use update.command instead.)
REM  If Windows SmartScreen warns, click "More info" then "Run anyway".

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-windows.ps1"
echo.
pause
