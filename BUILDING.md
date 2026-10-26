# Building BifroSSH

How to build and run BifroSSH from source. To install a released build instead, see the [README](README.md#install).

## Linux

Package names below are Fedora's; adjust for your distro.

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
git clone https://github.com/AalmanSadath/BifroSSH.git
cd BifroSSH
npm install
./install.sh
```

### install.sh commands

| Command | Action |
|---|---|
| `./install.sh` | Build and install as native desktop app |
| `./install.sh uninstall` | Remove native desktop app |
| `./install.sh flatpak` | Build and install as Flatpak |
| `./install.sh uninstall-flatpak` | Remove Flatpak and local repo |
| `./install.sh clean` | Delete build artefacts (`dist/`, `src-tauri/target/`, `flatpak/.build/`, `flatpak/.repo/`) without touching the installed app |

## Windows

Needs [Rust](https://rustup.rs), [Node.js 22+](https://nodejs.org) and the Visual Studio Build Tools with the "Desktop development with C++" workload. Then:

```powershell
git clone https://github.com/AalmanSadath/BifroSSH.git
cd BifroSSH
npm install
npm run tauri -- build --bundles nsis
```

The installer lands in `src-tauri\target\release\bundle\nsis`. `npm run tauri -- dev` runs it without packaging. `install.sh` is Linux only.

## Android

Needs [Rust](https://rustup.rs), [Node.js 22+](https://nodejs.org), JDK 21, and the Android SDK with NDK `29.0.14206865` (the version `src-tauri/gen/android/app/build.gradle.kts` pins). Point `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` at them, then:

```bash
rustup target add aarch64-linux-android
npm install
npm run tauri android build -- --debug --apk --target aarch64
```

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/universal/debug`. It installs as **BifroSSH Debug**, beside a release install rather than over it. With a phone connected over adb, `adb install -r` on that file puts it on the phone.

A release build (drop `--debug`) is signed only when `src-tauri/gen/android/keystore.properties` exists, with `storeFile`, `password`, `keyAlias` and `keyPassword`; otherwise it comes out unsigned.

## Build the Flatpak from source

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
flatpak run io.github.aalmansadath.bifrossh
```

The build runs entirely inside the sandbox with no network, so npm dependencies come from `flatpak/node-sources.json` and Cargo dependencies from `flatpak/cargo-sources.json`. Remove it again with `./install.sh uninstall-flatpak`.

## Development

```bash
npm install
npm run tauri dev
```
