# BifroSSH

A GUI SSH client built with Tauri 2, React, and Rust.

## Features

- **Terminal emulator** — full xterm.js terminal with configurable font, cursor, colour schemes, and 10 000-line scrollback
- **Multiple sessions** — open servers in tabs; sessions stay alive while you switch between them
- **SFTP file browser** — upload, download, create folders, delete, and rename files on remote servers; sort by name, size, or date with optional folders-on-top
- **SSH key management** — generate, import, and store Ed25519 / RSA / ECDSA keys in an encrypted local keychain; assign a key per server
- **Themes** — built-in dark and light themes plus a full theme editor; override the theme per session without changing server defaults
- **Codeprints** — save named commands and send them to any active terminal with one click (Paste or Run)
- **Host profiles** — store connection details (host, port, username, key) per server; quick-connect from the sidebar

---

## Install on Fedora

### 1. System dependencies (one-time)

```bash
sudo dnf install -y webkit2gtk4.1-devel javascriptcoregtk4.1-devel openssl-devel gtk3-devel \
  libappindicator-gtk3-devel librsvg2-devel curl file gcc
```

### 2. Rust (one-time)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 3. Node.js (one-time)

```bash
sudo dnf install -y nodejs npm
```

### 4. Clone and install

```bash
git clone git@github.com:AalmanSadath/BifroSSH.git
cd BifroSSH
npm install
./install.sh
```

#### install.sh commands

| Command | Action |
|---|---|
| `./install.sh` | Build and install as native desktop app |
| `./install.sh uninstall` | Remove native desktop app |
| `./install.sh flatpak` | Build and install as Flatpak |
| `./install.sh uninstall-flatpak` | Remove Flatpak and local repo |
| `./install.sh clean` | Delete build artefacts (`dist/`, `src-tauri/target/`, `flatpak/.build/`, `flatpak/.repo/`) without touching the installed app |

---

## Flatpak

### One-time setup

```bash
sudo dnf install flatpak-builder
flatpak install flathub org.gnome.Platform//50 org.gnome.Sdk//50
flatpak install flathub org.freedesktop.Sdk.Extension.rust-stable//25.08
flatpak install flathub org.freedesktop.Sdk.Extension.node22//25.08
```

### Build and install

```bash
./install.sh flatpak
```

The entire build runs inside the Flatpak sandbox — npm dependencies are supplied from the pre-vendored `flatpak/node-sources.json` and Cargo dependencies from `flatpak/cargo-sources.json`. No network access is needed at build time.

Run it:

```bash
flatpak run io.github.AalmanSadath.BifroSSH
```

### Uninstall

```bash
./install.sh uninstall-flatpak
```

### Adding new Rust dependencies

After updating `Cargo.lock`, regenerate the vendor sources:

```bash
pip install aiohttp tomlkit
python3 flatpak/flatpak-cargo-generator.py src-tauri/Cargo.lock -o flatpak/cargo-sources.json
```

### Adding new npm dependencies

After updating `package-lock.json`, regenerate the node sources:

```bash
pip install aiohttp
python3 flatpak/flatpak-node-generator.py npm package-lock.json -o flatpak/node-sources.json
```

Then rebuild with `./install.sh flatpak`.

---

## Development

```bash
npm install
npm run tauri dev
```

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, modify, and share; commercial use and paid subscriptions are not permitted.
