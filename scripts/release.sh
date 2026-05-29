#!/usr/bin/env bash
# Build a fresh plugin, package a ready-to-install zip, and publish it as a
# GitHub Release. Recipients just download the zip and follow INSTALL.txt —
# no Node, no terminal, no building on their end.
#
# Usage:  ./scripts/release.sh v0.2.0  ["Optional release notes"]
set -euo pipefail

VERSION="${1:?Usage: ./scripts/release.sh <version> [notes]   e.g. ./scripts/release.sh v0.2.0}"
NOTES="${2:-Plugin + extension build for ${VERSION}. See INSTALL.txt inside the zip.}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ Installing deps & building plugin…"
npm install --silent
npm run build

STAGE="$(mktemp -d)/figma-html-importer"
# Stable filename (no version) so releases/latest/download/<name> is a permanent
# link — the in-folder update.sh relies on this.
ZIP="$ROOT/figma-html-importer.zip"
mkdir -p "$STAGE/plugin"

# Only what a user needs to INSTALL — built output, manifests, docs, updater.
# No src/, no node_modules/, no internal Tests/ or sample/ captures.
cp -R plugin/dist "$STAGE/plugin/dist"
cp plugin/manifest.json "$STAGE/plugin/manifest.json"
cp -R extension "$STAGE/extension"
cp README.md INSTALL.txt update.sh update.command "$STAGE/"
chmod +x "$STAGE/update.sh" "$STAGE/update.command"
find "$STAGE" -name '.DS_Store' -delete

rm -f "$ZIP"
( cd "$(dirname "$STAGE")" && zip -rq "$ZIP" figma-html-importer )
echo "→ Packaged $(basename "$ZIP") ($(du -h "$ZIP" | cut -f1))"

echo "→ Creating GitHub release ${VERSION}…"
gh release create "$VERSION" "$ZIP" --title "$VERSION" --notes "$NOTES"

echo ""
echo "✓ Released ${VERSION}"
echo "  First-time download link to share:"
echo "    https://github.com/malkazazi/figma-html-importer/releases/latest"
echo "  Permanent direct-zip link (used by update.sh):"
echo "    https://github.com/malkazazi/figma-html-importer/releases/latest/download/figma-html-importer.zip"
