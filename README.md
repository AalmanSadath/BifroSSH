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

`install.sh` builds the app and registers it as a desktop application. Re-run it after pulling major changes.

## Flatpak

### One-time setup

```bash
sudo dnf install flatpak-builder
flatpak install flathub org.gnome.Platform//50 org.gnome.Sdk//50
flatpak install flathub org.freedesktop.Sdk.Extension.rust-stable//25.08
```

### Build and install

```bash
bash flatpak/build.sh
```

This builds the frontend, compiles the Tauri binary inside the Flatpak sandbox using pre-vendored Cargo dependencies (`flatpak/cargo-sources.json`), and installs the app locally.

Run it:

```bash
flatpak run com.bifrossh.app
```

### Adding new Rust dependencies

After updating `Cargo.lock`, regenerate the vendor sources:

```bash
pip install aiohttp tomlkit
python3 flatpak/flatpak-cargo-generator.py src-tauri/Cargo.lock -o flatpak/cargo-sources.json
```

Then rebuild with `bash flatpak/build.sh`.

## Development

```bash
npm install
npm run tauri dev
```
