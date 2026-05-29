#!/usr/bin/env bash
# Double-click this file (macOS) to update without opening Terminal yourself.
cd "$(dirname "${BASH_SOURCE[0]}")"
bash ./update.sh
echo ""
read -n 1 -s -r -p "Done — press any key to close this window."
echo ""
