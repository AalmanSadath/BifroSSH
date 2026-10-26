# BifroSSH

[![CI](https://github.com/AalmanSadath/BifroSSH/actions/workflows/ci.yml/badge.svg)](https://github.com/AalmanSadath/BifroSSH/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AalmanSadath/BifroSSH)](https://github.com/AalmanSadath/BifroSSH/releases/latest)
[![Android](https://img.shields.io/github/v/release/AalmanSadath/BifroSSH?display_name=release&filter=Android*&label=release)](https://github.com/AalmanSadath/BifroSSH/releases/tag/android-v0.3.0)
[![Add to Forager](https://aalmansadath.github.io/forager/badge.svg)](https://aalmansadath.github.io/forager/add/?url=https%3A%2F%2Fgithub.com%2FAalmanSadath%2FBifroSSH&tag_filter=%5Ev)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)

An SSH client for Linux, Windows and Android: tabbed terminal, SFTP, jump-host
chains, port forwarding and key management in one window.

- **Everything saved is encrypted.** Not just passwords: hostnames, usernames,
  jump chains, forwarding rules, saved commands and keys too, under one master
  key held in the system keyring, behind a passphrase, or both. Copying your
  home directory does not copy the key with it.
- **Host keys are checked before you log in**, the same way OpenSSH does it.
- **Keys can stay in your ssh-agent** and never enter the app, which is how
  YubiKeys and PIV smartcards work here.
- **Jump hosts, tunnels and SFTP** all follow the same chain of bastions.

Built in Rust with Tauri 2, russh and xterm.js. macOS and iOS are not supported.

![Multiple Hosts](screenshots/HostList.png)

## Install

| Platform | How |
|---|---|
| Linux | [Flatpak](#flatpak), [apt](#debian-ubuntu) or [dnf](#fedora-rhel) repository, or [Forager](#forager) |
| Windows | [Installer](#windows) from the latest release |
| Android | [APK](#android) from the latest Android release, kept updated by Obtainium if you like |

### Linux

The Flatpak, apt and dnf repositories are all served from
[bifrossh.aalman.dev](https://bifrossh.aalman.dev), signed with one key, and
update with the rest of your system.

#### Flatpak

```bash
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak remote-add --if-not-exists bifrossh https://bifrossh.aalman.dev/bifrossh.flatpakrepo
flatpak install bifrossh io.github.aalmansadath.bifrossh
flatpak run io.github.aalmansadath.bifrossh
```

On Ubuntu, add `--user` to each command above: a user-mode install avoids FUSE permission issues.

```bash
flatpak update io.github.aalmansadath.bifrossh     # update
flatpak uninstall io.github.aalmansadath.bifrossh  # remove
flatpak remote-delete bifrossh                     # and drop the remote
```

#### Debian, Ubuntu

```bash
curl -fsSL https://bifrossh.aalman.dev/bifrossh.sources | sudo tee /etc/apt/sources.list.d/bifrossh.sources
sudo apt update
sudo apt install bifrossh
```

The `.sources` file carries the signing key itself, so there is nothing to put
in `/etc/apt/keyrings` first, and the key is trusted for this repository only.

#### Fedora, RHEL

```bash
sudo dnf config-manager addrepo --from-repofile=https://bifrossh.aalman.dev/bifrossh.repo
sudo dnf install bifrossh
```

On dnf 4 (RHEL 9, Fedora 40 and older) the first line is
`sudo dnf config-manager --add-repo https://bifrossh.aalman.dev/bifrossh.repo`.

<details>
<summary>The key dnf asks you to trust</summary>

dnf asks once to trust the key. Its fingerprint is
`5B97 1E88 CAAA EDBB 0358 6DD1 49EF F0E4 91C7 7412`.

</details>

#### Forager

[Forager](https://github.com/AalmanSadath/forager) installs and updates apps
from their GitHub releases. With it installed, the **Add to Forager** badge at
the top of this page sets BifroSSH up, desktop releases only.

#### Good to know

- The `.deb` and `.rpm` install the binary as `/usr/bin/bifrossh`. Remove it
  with `sudo apt remove bifrossh` or `sudo dnf remove bifrossh`. Neither touches
  `~/.local/share/bifrossh`, which is where your hosts and keys live.
- They are built on Ubuntu 24.04 and need glibc 2.39 or newer. An older
  distribution will refuse them; use the Flatpak, which carries its own runtime.
- The `.deb` and `.rpm` are also on the
  [latest release](https://github.com/AalmanSadath/BifroSSH/releases/latest)
  for a machine you would rather not add a repository to. Installed that way
  they do not update.

<details>
<summary>Going back a version</summary>

The last ten releases stay in each repository.

```bash
# Flatpak: list them, then install one by its commit
flatpak remote-info --log bifrossh io.github.aalmansadath.bifrossh
flatpak update --commit=COMMIT io.github.aalmansadath.bifrossh
flatpak mask io.github.aalmansadath.bifrossh     # optional: stay there until `flatpak mask --remove`

# apt
apt list -a bifrossh
sudo apt install bifrossh=VERSION
sudo apt-mark hold bifrossh                     # optional: stay there until `apt-mark unhold`

# dnf
sudo dnf downgrade bifrossh
```

</details>

### Windows

Download `BifroSSH_x.y.z_x64-setup.exe` from the
[latest release](https://github.com/AalmanSadath/BifroSSH/releases/latest) and run it.

- It installs for the current user only, so there is no administrator prompt.
  Uninstall it from Settings > Apps.
- The installer is not code signed, so SmartScreen shows **"Windows protected
  your PC"** on first run. Click **More info**, then **Run anyway**. Signing
  needs a certificate that has to be bought and renewed, and nothing else makes
  that warning go away.
- Uninstalling leaves your data in `%APPDATA%\BifroSSH` unless you tick
  **Delete the application data**, which asks once more first, because nothing
  else holds a copy of your keys. An update never removes it.
- Needs Windows 10 1803 or later. WebView2 is already present on Windows 11 and
  current Windows 10; the installer fetches it if it is not.

### Android

The Android app has its own releases, tagged `android-vX.Y.Z` and numbered
apart from the desktop versions.

1. Download `BifroSSH_android_x.y.z_arm64.apk` from the
   [latest Android release](https://github.com/AalmanSadath/BifroSSH/releases/tag/android-v0.3.0).
   The release GitHub marks Latest is the desktop one.
2. Open it on the phone and allow your browser or file manager to install
   unknown apps when Android asks.
3. The first time you open the local side of SFTP, the file picker or an export,
   the app asks for access to all files, which Android grants from a settings
   screen. Without it those cannot read or write the phone's files.

Needs Android 7 or later on an arm64 phone or tablet.

**Updates with [Obtainium](https://github.com/ImranR98/Obtainium):** add this
repository, then set:

- **Filter release titles by regular expression:** `^Android v`
- **Verify the 'latest' tag:** off (GitHub's Latest is the desktop release)
- **Filter APKs by regular expression:** `_arm64\.apk$`

<details>
<summary>The APK's signing certificate</summary>

SHA-256 fingerprint:

```
26:4B:57:44:24:66:9F:FF:F1:7B:EE:FA:19:D4:25:91:1D:13:BC:B0:0A:1A:55:6B:78:A6:BD:19:A7:26:C3:55
```

</details>

## Features

### Hosts

- Add them by hand, or import them from `~/.ssh/config` (following `Include`,
  and bringing `ProxyJump`, `ProxyCommand`, `IdentityFile` and `CertificateFile`
  along), PuTTY, MobaXterm or a Termius CSV export.
- Per host: username, key or password, port, OS tag, default theme, connect
  timeout, `TERM`, environment variables, a command to type once logged in, and
  notes. Or share one identity across many servers.
- Sort hosts into groups, tag them, and filter by any of it (`#tag` matches one
  tag exactly). Select several to connect, tag, move or remove together.
- **Check hosts** times a plain TCP connect to each one, without logging in, and
  shows the latency on its card.
- The bar at the top connects to anything typed as `user@host -p 22`, saved or not.

### Jump hosts

- Reach a server through a bastion, like ssh's `ProxyJump`, chained as deep as
  you need. Terminal, SFTP and tunnels all follow the chain.
- Each hop has its own credentials and its own host key check, so a bastion on
  an agent key and a target on a password work together.
- Or use `ProxyCommand`, with `%h`, `%p`, `%r` and `%n`, for `cloudflared`, AWS
  SSM, `nc` through a proxy and the like. Inside the Flatpak the command runs on
  the host system, where those tools are installed.

### Terminal

- xterm.js with configurable scrollback (10 000 lines unless changed), font,
  cursor and per-session colours.
- **Ctrl+Shift+F** searches the scrollback, with case, whole-word and regex options.
- Selecting copies, right-click pastes. Links open in the browser, and an
  absolute path printed by a remote command opens in the SFTP panel when clicked.
- Each tab zooms on its own: Ctrl+=, Ctrl+-, Ctrl+0 or Ctrl+wheel.
- Sixel and iTerm2 images (`imgcat`, `chafa`) display inline. ZMODEM works:
  `sz` on the host saves files here, `rz` sends them there.
- Highlight rules colour matching output, such as errors in red.
- Commands are remembered per host and offered back as you type, the way fish
  does it. A command typed with a leading space is not kept.
- With the shell integration snippet (bash or zsh, copied from Settings), each
  tab shows how long the current command has run or how the last one exited.
- On Linux hosts, a bar under the terminal can show CPU, memory, disk, network and load.

![Searching the scrollback](screenshots/TerminalSearch.png)

### Tabs and windows

- Any number of sessions in tabs, each independent. Rename a tab, duplicate it,
  or drag it onto the terminal to show up to four side by side.
- A tab can move into a window of its own and come back; closing that window
  brings it back too.
- Broadcast: what you type goes to every tab marked for it.
- A tab's scrollback can be copied or saved as text.
- A local shell opens in a tab as well: your login shell on Linux, PowerShell on
  Windows, or any program you set.
- Tabs open at exit reopen and reconnect at the next launch, under the names you
  gave them, unless you turn that off.

![Two sessions side by side](screenshots/SplitPanes.png)

### Keyboard and command palette

- Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+PageDown and Ctrl+PageUp) move between
  tabs. Ctrl+1 to Ctrl+8 pick one, Ctrl+9 picks the last.
- Ctrl+Shift+T duplicates a tab, Ctrl+Shift+W closes it, Ctrl+Shift+N opens a
  local shell, Ctrl+Shift+B toggles broadcast. Ctrl+Shift+C and Ctrl+Shift+V
  copy and paste.
- Every shortcut can be rebound or turned off in Settings, which tells you when
  a key is already taken.
- **Ctrl+K** opens the command palette: open tabs, hosts, SFTP to any host,
  codeprints, every panel and settings page, and actions such as broadcast,
  recording, moving a tab to its own window and locking the vault.

![The command palette](screenshots/CommandPalette.png)

### SFTP

- Browse, upload, download, rename and delete, including whole folders in either
  direction or straight between two remote servers, with per-file progress.
- Copy a folder as one compressed stream instead of file by file; between two
  servers it never touches this computer's disk.
- Compare two folders by size and SHA-256 before copying anything.
- Change permissions and owner, bookmark folders, or open a remote file in its
  usual application and have every save uploaded back.
- A file already at the destination asks: overwrite, skip or keep both.
- A transfer that stops can be resumed where it got to, and the result is checked
  against the original. Settings can have every transfer checked that way
  (needs `sha256sum` on the server).
- Drag files in from the file manager to upload (Linux only). The lists work from
  the keyboard, with a filter that starts as you type.

![SFTP, local beside remote](screenshots/SFTPSession.png)

### SSH keys and ssh-agent

- Generate Ed25519, ECDSA (P-256) and RSA (2048 or 4096) keys, or import existing
  ones, PuTTY `.ppk` files included. Private keys are stored encrypted and never
  written to disk in the clear.
- A key can instead stay in its file and be read from there, which is how keys
  named in `~/.ssh/config` arrive.
- OpenSSH user certificates attach to their key with the expiry shown; a
  `-cert.pub` beside a key file is picked up by itself.
- Use keys held by a running agent instead, so they never enter the app. That is
  how PIV smartcards and YubiKeys work, since their keys cannot be exported.
  - Linux: the agent named by `SSH_AUTH_SOCK`.
  - Windows: the OpenSSH agent service over its named pipe, or any agent that
    advertises its own pipe through `SSH_AUTH_SOCK`.
  - Pageant is not supported, and neither are FIDO keys (`ed25519-sk`,
    `ecdsa-sk`) yet.
- The Keychain lists the agent's keys, and an identity can be pinned to one of them.
- Agent forwarding (`ssh -A`) can be turned on per host, so programs there can use
  your keys without the keys leaving this machine. Anyone with root on that host
  can use them too while the session is open, so it is off unless you turn it on.

### Two-factor and keyboard-interactive

- Servers that ask challenge questions at login work, including PAM setups with
  `PasswordAuthentication` off and providers like Duo and TOTP apps.
- Where the server offers a choice of factors, they appear as buttons.
- Password and key logins fall back to this automatically.

### Port forwarding

- Local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`) tunnels, created with a
  wizard and started from a card. Several can run at once, each on the address
  you bind it to.
- A tunnel can start when BifroSSH opens or when you connect to its host, and one
  started that way restarts by itself if it drops.
- The SOCKS5 server handles CONNECT only, without authentication.

![Port forwarding rules](screenshots/PortForwarding.png)

### X11 forwarding

- Turn it on per host, like `ssh -X`, and graphical programs started there open
  their windows here. The host needs `X11Forwarding yes` and `xauth`.
- The server gets a cookie made for the session, not your real one. But while
  the session is open, a program there can read your display's keyboard and
  screen like any other X client, so it is off unless you turn it on.
- On Windows, run an X server such as VcXsrv first.

### Containers

- Pick a host to list its Docker and Podman containers. Start, stop or restart
  them, open a shell in one, or follow its logs in a tab.
- With sudo, root's containers are listed too.

![Containers on a host](screenshots/Containers.png)

### Recording and logging

- Record a session as an asciicast and play it back in the app at 1×, 2× or 4×
  with a seek bar, or in any asciinema player.
- Or log a session's raw output to a file, from the tab's menu or for every
  session to a host.

![Playing back a recorded session](screenshots/Recordings.png)

### Codeprints

- Named commands you keep around, pasted into the prompt to edit or run outright,
  shared across every session.
- `{{name}}` or `{{name:default}}` placeholders are filled in each time one is used.

![Codeprints sidebar](screenshots/SessionwithCodePrints.png)

### Themes

- Dark and light built in, plus an editor for every colour, all 16 ANSI slots
  included.
- Apply a theme to one session without changing the host's default.
- The app follows the desktop's light or dark mode, or is set to dark, light or
  AMOLED black, with your own accent colour or the desktop's.

![Theme editor](screenshots/ThemeEditor.png)

### Export and import

- One encrypted `.bfx` file holds hosts, identities, keys, tunnels, codeprints,
  themes, settings and known hosts, for moving to another machine or keeping a
  backup. Passwords and private keys can be left out.
- Importing shows what the file holds and lets you pick what to bring in.
- It only ever adds: anything already there is kept and reported as skipped, so
  importing the same file twice is safe. Settings are the exception, and replace
  yours if you tick them.

![Exporting a setup](screenshots/ExportData.png)

### Connection reliability

- Configurable keepalives stop idle sessions being dropped by NAT and firewall timers.
- Every connection keeps a log of how it was set up, still readable afterwards.
- A dropped session keeps its tab and scrollback and reconnects by itself: after
  5 seconds, then twice as long each time up to a minute, five tries unless set
  otherwise. Enter in the tab tries again at once.

### Updates

- At launch BifroSSH asks GitHub whether a newer release exists (one request,
  nothing downloaded) and says so in the sidebar.
- Settings can turn that off, and has **Check now**.

### On Android

The phone app has the same hosts, terminal, SFTP, keys, tunnels and vault, plus:

- **Fingerprint or app PIN unlock**, with the master passphrase as the way back
  in. Five wrong PINs switch the PIN off.
- **An extra key bar** above the keyboard: Esc, Tab, Ctrl, Alt, the arrows and paste.
- **Connections stay open in the background**, with a notification that counts
  them and can disconnect them all. Optionally kept alive with the screen off too.
- **Lock after leaving the app**, immediately or after a few minutes.
- **Launcher shortcuts** to your recent hosts, and any host can be pinned to the
  home screen.
- **`ssh://` links** from other apps open here, and **text shared** from another
  app can be pasted into a terminal.
- **Volume keys** change the terminal's text size.
- **Network changes** (Wi-Fi to mobile data and back) reconnect sessions at once.

The local shell, X11 forwarding, the SSH agent, the desktop keyring and separate
windows are desktop only.

## Security

In short:

- Host keys are checked before you log in, and a changed key is treated as an attack.
- Everything saved is encrypted under one master key, not just the passwords.
- You choose where that key lives: the system keyring, a passphrase, or both.
- The vault can be locked by hand, after a period of no input, or before the
  computer sleeps. Open sessions stay connected behind the lock.

### Host keys

Host keys are verified before authenticating, the same way OpenSSH does. Three
policies are available:

- **Ask** (default): an unknown server shows its fingerprint for you to trust
  and save, or to connect to once without saving.
- **Accept new:** unknown servers are trusted and saved.
- **Strict:** only servers already known are allowed.

A server presenting a different key than the one stored is what a
man-in-the-middle looks like. Accept new and Strict refuse it outright. Ask
shows both fingerprints with a warning and goes on only if you tick a box
confirming the new key replaces the old one. A key marked `@revoked` is refused
under every policy.

![Confirming a fingerprint on first connection](screenshots/HostKeyPrompt.png)

Trusted keys live in BifroSSH's own `known_hosts`, in standard OpenSSH format,
beside the rest of its data: `~/.local/share/bifrossh` on Linux and
`%APPDATA%\BifroSSH` on Windows. Your OpenSSH `known_hosts`
(`~/.ssh/known_hosts`, or `%USERPROFILE%\.ssh\known_hosts`) is also read, so a
server you have already connected to from a terminal never prompts. That file
is only ever read, never modified. The Known Hosts panel lists both and forgets
BifroSSH's own entries on request.

### Encryption

The whole of `data.json` is encrypted with a single master key, not just the
credentials, so hostnames, usernames, jump chains, forwarding rules and saved
commands are not left in the clear either.

On first launch you choose where the master key lives, and can change it later
in Settings:

- **The system keyring, with a passphrase to fall back on.** Unlocks without
  asking. On Linux that is the desktop keyring, through the Secret portal inside
  Flatpak and the Secret Service outside it. On Windows it is DPAPI, which seals
  the key to your Windows account: the sealed file is worthless to another
  account or on another machine. Either way the key is not usable from disk
  alone, and the passphrase means losing the keyring cannot lock you out.
- **Passphrase only.** Asked at every launch; the key exists nowhere until you
  type it. The only option that protects your keys from something already
  running as your user, and the only one where forgetting the passphrase loses
  them.
- **A file, no passphrase.** Nothing to remember. The key sits beside your data,
  protected only by the file's permissions.

Settings always shows which one is in use. Where a passphrase is wanted, a dice
button generates an eight-word phrase from the
[BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) English
list (88 bits, hashed with Argon2id); capitalisation and spacing are ignored
when you type it back. A passphrase you write yourself is taken exactly as typed.

None of this defends against malware running as you while the app is unlocked,
and neither platform offers a way to. What it buys is that copying your home
directory no longer copies the key along with the data.

### Locking

- **Ctrl+Shift+L** closes the vault: the key is zeroed and dropped, and the
  master passphrase is needed to open it again.
- Settings can also lock after a period with no input from you (off unless you
  turn it on) and before the computer sleeps (on by default), so what is on
  screen when the lid opens is the unlock screen.
- Locking needs a passphrase to be set; with the keyring alone the vault would
  reopen itself.
- Terminal sessions and tunnels already open stay connected behind the lock, the
  same as a screen lock over a shell. The key was used when they connected and
  is not what they run on.

### The data folder

- On Linux the folder and everything in it is `0700`/`0600`, set at creation
  rather than after, so no other account can read it.
- Windows has no equivalent and BifroSSH does not write an ACL of its own:
  `%APPDATA%\BifroSSH` inherits your user profile's permissions, which keep out
  other standard accounts but not an administrator.

## Build from source

See [BUILDING.md](BUILDING.md) for building on Linux, Windows and Android, and
for building the Flatpak yourself.

## License

[GPL-3.0-or-later](LICENSE): free to use, modify, and distribute; derivatives must also be open source under GPL-3.0 or later.

Bundled content written by other people, and the terms it comes under, is listed in [THIRD_PARTY.md](THIRD_PARTY.md).
