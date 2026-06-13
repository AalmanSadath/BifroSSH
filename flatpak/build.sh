#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

BUILD_DIR=flatpak/.build
REPO_DIR=flatpak/.repo

# Save terminal state; disable echo so CPR responses from terminal queries
# (ESC[6n) don't get echoed back as visible text during build tool execution.
_stty_save=$(stty -g 2>/dev/null) || true
stty -echo 2>/dev/null || true

_restore_tty() {
    if [ -n "$_stty_save" ]; then
        stty "$_stty_save" 2>/dev/null || true
    else
        stty sane 2>/dev/null || true
    fi
    printf '\033[?2004l' 2>/dev/null || true
}
trap _restore_tty EXIT

echo "==> Cleaning previous build..."
rm -rf "$BUILD_DIR"

echo "==> Building frontend (required before Flatpak build)..."
npm run build

echo "==> Building Flatpak..."
flatpak-builder \
    --force-clean \
    --repo="$REPO_DIR" \
    --install-deps-from=flathub \
    "$BUILD_DIR" \
    flatpak/com.bifrossh.app.yml

echo "==> Adding local repo..."
flatpak remote-add --no-gpg-verify --if-not-exists bifrossh-local "$REPO_DIR"

echo "==> Installing..."
flatpak install --reinstall --assumeyes bifrossh-local com.bifrossh.app

_restore_tty
trap - EXIT

echo ""
echo "Done. Run with:"
echo "  flatpak run com.bifrossh.app"
