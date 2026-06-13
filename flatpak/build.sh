#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

BUILD_DIR=flatpak/.build
REPO_DIR=flatpak/.repo

echo "==> Cleaning previous build..."
rm -rf "$BUILD_DIR"

echo "==> Building frontend (required before Flatpak build)..."
npm run build

echo "==> Building Flatpak..."
# TERM=dumb prevents flatpak-builder from sending cursor-position queries
# (ESC[6n) that cause ;12R to leak into terminal output.
TERM=dumb flatpak-builder \
    --force-clean \
    --repo="$REPO_DIR" \
    --install-deps-from=flathub \
    "$BUILD_DIR" \
    flatpak/com.bifrossh.app.yml

echo "==> Adding local repo..."
flatpak remote-add --no-gpg-verify --if-not-exists bifrossh-local "$REPO_DIR"

echo "==> Installing..."
TERM=dumb flatpak install --reinstall --assumeyes bifrossh-local com.bifrossh.app

printf '\033[?2004l' 2>/dev/null || true
stty sane 2>/dev/null || true

echo ""
echo "Done. Run with:"
echo "  flatpak run com.bifrossh.app"
