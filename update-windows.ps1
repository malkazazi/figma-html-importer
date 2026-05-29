# ============================================================
#  WINDOWS ONLY — updater for the HTML -> Figma Importer
# ============================================================
# Updates this folder to the latest version, then you reload the extension in
# Chrome and re-run the plugin in Figma. (macOS users: use update.command.)
# Normally you run this by double-clicking update-windows.bat.

$ErrorActionPreference = 'Stop'
$installDir = $PSScriptRoot
$url = 'https://github.com/malkazazi/figma-html-importer/releases/latest/download/figma-html-importer.zip'
$tmpZip = Join-Path $env:TEMP 'fhi-update.zip'
$tmpDir = Join-Path $env:TEMP 'fhi-update'

Write-Host 'Downloading the latest version...'
Invoke-WebRequest -Uri $url -OutFile $tmpZip

Write-Host 'Updating your files...'
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
Copy-Item -Path (Join-Path $tmpDir 'figma-html-importer\*') -Destination $installDir -Recurse -Force
Remove-Item $tmpZip -Force
Remove-Item $tmpDir -Recurse -Force

Write-Host ''
Write-Host 'Updated to the latest version.'
Write-Host 'Now refresh both apps:'
Write-Host '  - Chrome: open chrome://extensions and click the reload icon on "Figma Multi-Breakpoint Capture".'
Write-Host '  - Figma:  re-run the "HTML Importer (Local)" plugin.'
