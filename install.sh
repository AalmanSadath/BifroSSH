#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="BifroSSH"
BIN_NAME="bifrossh"
IDENTIFIER="com.bifrossh.app"

INSTALL_BIN="$HOME/.local/bin/$BIN_NAME"
INSTALL_DESKTOP="$HOME/.local/share/applications/$IDENTIFIER.desktop"
ICON_DIR="$HOME/.local/share/icons/hicolor"

# ── Flatpak install ───────────────────────────────────────────────────────────

if [[ "${1:-}" == "flatpak" ]]; then
    echo "==> Installing $APP_NAME as Flatpak"
    cd "$SCRIPT_DIR"
    if ! command -v flatpak-builder &>/dev/null; then
        echo "ERROR: flatpak-builder not found. Install with: sudo dnf install flatpak-builder" >&2
        exit 1
    fi
    bash flatpak/build.sh
    exit 0
fi

# ── Flatpak uninstall ─────────────────────────────────────────────────────────

if [[ "${1:-}" == "uninstall-flatpak" ]]; then
    echo "==> Uninstalling $APP_NAME Flatpak"
    flatpak uninstall --assumeyes "$IDENTIFIER" 2>/dev/null || true
    flatpak remote-delete --force bifrossh-local 2>/dev/null || true
    echo "Done."
    exit 0
fi

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "uninstall" ]]; then
    echo "==> Uninstalling $APP_NAME"
    rm -f "$INSTALL_BIN"
    rm -f "$INSTALL_DESKTOP"
    rm -f "$ICON_DIR/32x32/apps/$BIN_NAME.png"
    rm -f "$ICON_DIR/128x128/apps/$BIN_NAME.png"
    rm -f "$ICON_DIR/256x256/apps/$BIN_NAME.png"
    command -v update-desktop-database &>/dev/null && update-desktop-database "$HOME/.local/share/applications"
    command -v gtk-update-icon-cache &>/dev/null && gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null || true
    echo "Done. $APP_NAME uninstalled."
    exit 0
fi

# ── 1. Build ─────────────────────────────────────────────────────────────────

echo "==> Building $APP_NAME (release)…"

# Source cargo env in case it's not in PATH
if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

cd "$SCRIPT_DIR"
# Build frontend, then compile Rust release — skips AppImage/deb/rpm packaging.
echo "  [1/2] building frontend…"
npm run build 2>&1 | tail -5
echo "  [2/2] compiling Rust…"
# --features tauri/custom-protocol tells Tauri to serve from embedded assets
# instead of the dev server URL (http://localhost:1420).
cargo build --release --manifest-path src-tauri/Cargo.toml \
    --features tauri/custom-protocol 2>&1 | tail -10

RELEASE_BIN="$SCRIPT_DIR/src-tauri/target/release/$BIN_NAME"
if [[ ! -f "$RELEASE_BIN" ]]; then
    echo "ERROR: release binary not found at $RELEASE_BIN" >&2
    exit 1
fi

# ── 2. Install binary ─────────────────────────────────────────────────────────

echo "==> Installing binary to $INSTALL_BIN"
mkdir -p "$HOME/.local/bin"
cp "$RELEASE_BIN" "$INSTALL_BIN"
chmod +x "$INSTALL_BIN"

# ── 3. Install icons ──────────────────────────────────────────────────────────

echo "==> Installing icons"
declare -A ICON_MAP=(
    ["32x32"]="32x32"
    ["128x128"]="128x128"
    ["icon"]="256x256"
)

for src_base in "${!ICON_MAP[@]}"; do
    size="${ICON_MAP[$src_base]}"
    src="$SCRIPT_DIR/src-tauri/icons/${src_base}.png"
    dst_dir="$ICON_DIR/${size}/apps"
    if [[ -f "$src" ]]; then
        mkdir -p "$dst_dir"
        cp "$src" "$dst_dir/$BIN_NAME.png"
    fi
done

# ── 4. Write .desktop file ────────────────────────────────────────────────────

echo "==> Writing desktop entry to $INSTALL_DESKTOP"
mkdir -p "$HOME/.local/share/applications"

cat > "$INSTALL_DESKTOP" <<EOF
[Desktop Entry]
Name=$APP_NAME
Comment=SSH client
Exec=env WEBKIT_DISABLE_DMABUF_RENDERER=1 $INSTALL_BIN
Icon=$BIN_NAME
Terminal=false
Type=Application
Categories=Network;RemoteAccess;
Keywords=ssh;terminal;remote;
StartupNotify=true
StartupWMClass=$BIN_NAME
EOF

# ── 5. Refresh desktop database ───────────────────────────────────────────────

if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$HOME/.local/share/applications"
fi

if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null || true
fi

echo ""
echo "Done. '$APP_NAME' is now searchable in your app launcher."
echo "If it doesn't appear immediately, log out and back in (or run: xdg-open $INSTALL_DESKTOP)"
