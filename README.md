# BifroSSH

A fast SSH client built with Tauri 2, React, and Rust.

## Install on Fedora

### 1. System dependencies (one-time)

```bash
sudo dnf install -y webkit2gtk4.1-devel javascriptcoregtk4.1-devel openssl-devel gtk3-devel \
  libappindicator-gtk3-devel librsvg2-devel \
  curl file gcc
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

## Flatpak

### One-time setup

```bash
sudo dnf install flatpak-builder
flatpak install flathub org.gnome.Platform//50 org.gnome.Sdk//50
flatpak install flathub org.freedesktop.Sdk.Extension.rust-stable//25.08
```

### Build and install

```bash
./install.sh flatpak
```

This builds the frontend, compiles the Tauri binary inside the Flatpak sandbox using pre-vendored Cargo dependencies (`flatpak/cargo-sources.json`), and installs the app locally.

Run it:

```bash
flatpak run com.bifrossh.app
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

Then rebuild with `./install.sh flatpak`.

## Development

```bash
npm install
npm run tauri dev
```
