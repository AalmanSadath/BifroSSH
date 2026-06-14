# BifroSSH

A GUI SSH client built with Tauri 2, React, and Rust.

## Features

### Terminal emulator
Full xterm.js terminal with configurable font family, font size, cursor style, and colour scheme. Supports 10 000-line scrollback, copy/paste, and standard terminal escape sequences. Each session runs in its own tab and stays alive while you switch between tabs.

### Multiple sessions
Open any number of servers at once in tabs. Sessions are independent, so running a long command on one server does not block interaction with another. Closing a tab disconnects cleanly.

### SFTP file browser
Browse, upload, download, rename, delete, and create folders on remote servers without leaving the app. The file list can be sorted by name, size, or modification date, with an option to show folders at the top. Supports both key-based and password-based auth, and works with per-host credentials or shared identities.

### SSH key management
Generate Ed25519, RSA, and ECDSA keys directly in the app. Import existing keys. All private keys are stored in an encrypted local keychain and are never written to disk unencrypted. Assign a key to a server or identity; the app decrypts and uses it at connect time.

### Themes and per-session colours
Ships with dark and light themes. The built-in theme editor lets you customise every colour: background, foreground, cursor, selection, and all 16 ANSI colours. Theme changes can be applied per-session without changing the server's default theme.

### Codeprints
Save named shell commands with a label. Open the Codeprints sidebar in any session and click **Paste** to insert the command into the prompt (so you can edit it first) or **Run** to execute it immediately. Codeprints are global, one list shared across all sessions and servers.

Typical uses:
- Restart services: `sudo systemctl restart nginx`
- Tail logs: `journalctl -fu myapp`
- Deploy scripts, database queries, monitoring one-liners

### Host profiles
Store connection details per server: hostname, port, username, SSH key or password, identity, and default theme. Each server has an OS tag (Linux, Ubuntu, Debian, Arch, Fedora, macOS, Windows, FreeBSD, Raspberry Pi) shown as an icon in the sidebar. Quick-connect from the sidebar with one click. Supports per-host credentials or shared identities reused across servers.

---

## Install via Flatpak repo (no build required)

The easiest install - no Rust, Node.js, or build tools needed.

```bash
flatpak remote-add bifrossh https://aalmansadath.github.io/BifroSSH/bifrossh.flatpakrepo
flatpak install bifrossh io.github.aalmansadath.bifrossh
```

Or download [`bifrossh.flatpakrepo`](bifrossh.flatpakrepo) and double-click it in GNOME Files to add via GNOME Software.

**Run:**
```bash
flatpak run io.github.aalmansadath.bifrossh
```

**Update:**
```bash
flatpak update io.github.aalmansadath.bifrossh
```

**Uninstall:**
```bash
flatpak uninstall io.github.aalmansadath.bifrossh
flatpak remote-delete bifrossh
```

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

## Build Flatpak from source

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
flatpak run io.github.aalmansadath.bifrossh
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

[GPL-3.0-or-later](LICENSE) — free to use, modify, and distribute; derivatives must also be open source under GPL-3.0 or later.
