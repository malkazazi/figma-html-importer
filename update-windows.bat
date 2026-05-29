@echo off
REM ============================================================
REM  WINDOWS ONLY — double-click to update the HTML -> Figma Importer
REM ============================================================
REM  (macOS users: use update-macos.command instead.)
REM  If Windows SmartScreen warns: click "More info" then "Run anyway".
REM  Afterward, reload the extension in Chrome and re-run the plugin in Figma.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $u='https://github.com/malkazazi/figma-html-importer/releases/latest/download/figma-html-importer.zip'; $z=Join-Path $env:TEMP 'fhi-update.zip'; $t=Join-Path $env:TEMP 'fhi-update'; Write-Host 'Downloading the latest version...'; Invoke-WebRequest -Uri $u -OutFile $z; Write-Host 'Updating your files...'; if(Test-Path $t){Remove-Item $t -Recurse -Force}; Expand-Archive -Path $z -DestinationPath $t -Force; Copy-Item -Path (Join-Path $t 'figma-html-importer\*') -Destination '%~dp0' -Recurse -Force; Remove-Item $z -Force; Remove-Item $t -Recurse -Force; Write-Host ''; Write-Host 'Updated to the latest version.'; Write-Host 'Now: reload the extension in chrome://extensions, then re-run the plugin in Figma.'"
echo.
pause
