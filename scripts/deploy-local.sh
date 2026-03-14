#!/bin/bash
set -e

cd "$(dirname "$0")/.."

APP_NAME="CodePilot.app"
RELEASE_DIR="release/mac-arm64"
DEST_DIR="$HOME/Applications"

echo "=== Cleaning previous build ==="
rm -rf release/ .next/

echo "=== Building Next.js + Electron ==="
npm run electron:build

echo "=== Packaging (arm64, unpacked only) ==="
npx electron-builder --mac --dir --arm64 --config electron-builder.yml

echo "=== Installing to ~/Applications ==="
# Quit running app if any
osascript -e 'quit app "CodePilot"' 2>/dev/null || true
sleep 1

rm -rf "$DEST_DIR/$APP_NAME"
cp -R "$RELEASE_DIR/$APP_NAME" "$DEST_DIR/$APP_NAME"

echo "=== Done ==="
echo "Installed: $DEST_DIR/$APP_NAME"

# Launch if --launch flag is passed
if [[ "$1" == "--launch" ]]; then
  echo "Launching..."
  open "$DEST_DIR/$APP_NAME"
fi
