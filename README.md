# BifroSSH

A GUI SSH client built with Tauri 2, React, and Rust.

## Features

### Host profiles
Import your existing hosts straight from `~/.ssh/config`, or add them by hand. Store connection details per server: hostname, port, username, SSH key or password, identity, and default theme. Each server has an OS tag (Linux, Ubuntu, Debian, Arch, Fedora, macOS, Windows, FreeBSD, Raspberry Pi) shown as an icon in the sidebar. Quick-connect from the sidebar with one click. Supports per-host credentials or shared identities reused across servers.

### SFTP file browser
Browse, upload, download, rename, delete, and create folders on remote servers without leaving the app. Whole folders can be transferred in either direction, or between two remote servers, and are copied recursively with a progress readout showing which file of how many is moving. Symbolic links are skipped rather than followed. The file list can be sorted by name, size, or modification date, with an option to show folders at the top. Supports both key-based and password-based auth, and works with per-host credentials or shared identities.

### SSH key management
Generate Ed25519, RSA, and ECDSA keys directly in the app. Import existing keys. All private keys are stored in an encrypted local keychain and are never written to disk unencrypted. Assign a key to a server or identity; the app decrypts and uses it at connect time.

### ssh-agent
Set an identity's auth mode to **Agent** to authenticate with keys held by a running ssh-agent, rather than importing the private key into BifroSSH. The agent signs the challenge, so the key never enters the app.

This is the way to use keys you have already loaded with `ssh-add` or that your desktop keyring holds, and the only way to use PIV smartcards and YubiKeys in PIV mode, whose keys cannot be exported. Pick a specific key by fingerprint, or let BifroSSH try each key the agent offers.

FIDO security keys (`ed25519-sk`, `ecdsa-sk`) are not supported yet. They are ignored rather than breaking the rest of the agent, so other keys still work when one is loaded.

### Two-factor and keyboard-interactive login
Supports servers that ask challenge questions at login instead of accepting a stored credential, including PAM setups where `PasswordAuthentication` is turned off, and two-factor providers such as Duo, TOTP authenticator apps, and hardware tokens.

Set an identity's auth mode to **Prompt** and nothing is stored for it; the server asks and you answer at connect time. When the server offers a choice of second factors, the options are shown as buttons, so approving a push notification or requesting a phone call is a single click. Passcodes can still be typed for SMS codes and authenticator apps.

Password and key logins also fall back to this automatically, so a server that turns out to want a second factor still connects rather than failing.

### Known hosts
Every connection verifies the server's host key before authenticating, the same way OpenSSH does. The first time you connect to a server, its fingerprint is shown for you to confirm; once trusted, it is remembered and checked on every later connection. If a server ever presents a different key than the one stored, the connection is refused and you are warned, because this is what a man-in-the-middle attack looks like.

Trusted keys are kept in `~/.local/share/bifrossh/known_hosts` in standard OpenSSH format. Your existing `~/.ssh/known_hosts` is also read, so servers you have already connected to from a terminal are trusted automatically and never prompt. That file is only ever read, never modified.

Three policies are available for servers you have not seen before:

- **Ask** (default): shows the fingerprint and waits for you to confirm.
- **Accept new**: trusts an unknown server automatically on first connection.
- **Strict**: refuses any server that is not already trusted.

A key that does not match the one already stored is refused under all three. Stored keys can be reviewed, searched, and individually forgotten from the Known Hosts panel.

### Port forwarding
Create and manage SSH port forwarding rules. Three forwarding types are supported:

- **Local** (`-L`): opens a port on the local machine and forwards traffic through the SSH host to a destination address. Useful for accessing services on a remote network as if they were local.
- **Remote** (`-R`): opens a port on the remote SSH host and forwards incoming traffic back to a local destination. Useful for exposing a local service to a remote machine.
- **Dynamic** (`-D`): opens a local SOCKS5 proxy port. Any SOCKS5-aware app can route its traffic through the SSH host, acting as a tunnel for arbitrary destinations.

Rules are created with a step-by-step wizard or directly via the edit form. Double-click a card (or right-click and select Activate) to start the tunnel. Multiple tunnels can run simultaneously and are stopped individually or all at once via right-click and Kill all active tunnels.

### Themes and per-session colours
Ships with dark and light themes. The built-in theme editor lets you customise every colour: background, foreground, cursor, selection, and all 16 ANSI colours. Theme changes can be applied per-session without changing the server's default theme.

### Terminal emulator
Full xterm.js terminal with configurable font family, font size, cursor style, and colour scheme. Supports 10 000-line scrollback, copy/paste, and standard terminal escape sequences. Each session runs in its own tab and stays alive while you switch between tabs.

### Multiple sessions
Open any number of servers at once in tabs. Sessions are independent, so running a long command on one server does not block interaction with another. Closing a tab disconnects cleanly.

### Connection reliability
Sessions and tunnels send a periodic keepalive, so they are not dropped by a NAT or firewall idle timer while you are not typing, and a connection to a host that has gone away reports itself instead of hanging. The interval is configurable, and can be turned off.

Every connection keeps a log of how it was established: address resolution, host key verification, authentication, and the shell or SFTP subsystem starting. It stays available from the session sidebar, so a connection that failed or behaved oddly can be looked at after the fact rather than only while it is still on screen.

### Codeprints
Save named shell commands with a label. Open the Codeprints sidebar in any session and click **Paste** to insert the command into the prompt (so you can edit it first) or **Run** to execute it immediately. Codeprints are global, one list shared across all sessions and servers.

Typical uses:
- Restart services: `sudo systemctl restart nginx`
- Tail logs: `journalctl -fu myapp`
- Deploy scripts, database queries, monitoring one-liners

---

## Install via Flatpak repo (no build required)

The easiest install - no Rust, Node.js, or build tools needed.

### Fedora

```bash
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak remote-add bifrossh https://aalmansadath.github.io/BifroSSH/bifrossh.flatpakrepo
flatpak install bifrossh io.github.aalmansadath.bifrossh
```

### Ubuntu and other distros

Ubuntu requires a user-mode install to avoid FUSE permission issues:

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak remote-add --user bifrossh https://aalmansadath.github.io/BifroSSH/bifrossh.flatpakrepo
flatpak install --user bifrossh io.github.aalmansadath.bifrossh
```

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

The entire build runs inside the Flatpak sandbox. npm dependencies are supplied from the pre-vendored `flatpak/node-sources.json` and Cargo dependencies from `flatpak/cargo-sources.json`. No network access is needed at build time.

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

[GPL-3.0-or-later](LICENSE): free to use, modify, and distribute; derivatives must also be open source under GPL-3.0 or later.
