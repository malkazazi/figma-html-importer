#!/usr/bin/env bash
# Updates this HTML → Figma Importer folder to the latest version.
# Double-click this file in Finder, or run it from a terminal:  bash update.command
# Afterward, reload the extension in Chrome and re-run the plugin in Figma.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="https://github.com/malkazazi/figma-html-importer/releases/latest/download/figma-html-importer.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading the latest version…"
if ! curl -fsSL "$URL" -o "$TMP/update.zip"; then
  echo "✗ Download failed — check your internet connection and try again."
  exit 1
fi

echo "→ Updating your files…"
unzip -oq "$TMP/update.zip" -d "$TMP"
cp -R "$TMP/figma-html-importer/." "$INSTALL_DIR/"

echo ""
echo "✓ Updated to the latest version."
echo ""
echo "Now refresh both apps:"
echo "  • Chrome:  open chrome://extensions and click the reload (↻) icon"
echo "             on \"Figma Multi-Breakpoint Capture\"."
echo "  • Figma:   just re-run the \"HTML Importer (Local)\" plugin —"
echo "             it picks up the new files automatically."
