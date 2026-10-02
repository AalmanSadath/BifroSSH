#!/usr/bin/env bash
# Writes the files at the root of the site: what a user downloads to add one
# of the repositories, the public key, the landing page, and
# published-version.
#
#   descriptors.sh SITE VERSION
source "$(dirname "$0")/common.sh"

site="$1" version="$2"
need GPG_FINGERPRINT
here="$(dirname "$0")"
mkdir -p "$site"

gpg --batch --export "$GPG_FINGERPRINT" > "$site/bifrossh.gpg"
gpg --batch --armor --export "$GPG_FINGERPRINT" > "$site/bifrossh.asc"
key_b64="$(base64 -w0 < "$site/bifrossh.gpg")"

cat > "$site/bifrossh.flatpakrepo" <<EOT
[Flatpak Repo]
Title=BifroSSH
Url=$BASE/flatpak/
Homepage=https://github.com/AalmanSadath/BifroSSH
Comment=GUI SSH client with built-in SFTP and keychain management
Description=Signed Flatpak repository for BifroSSH
Icon=https://raw.githubusercontent.com/AalmanSadath/BifroSSH/main/src-tauri/icons/128x128.png
GPGKey=$key_b64
EOT

cat > "$site/$APP_ID.flatpakref" <<EOT
[Flatpak Ref]
Title=BifroSSH
Name=$APP_ID
Branch=$FLATPAK_BRANCH
Url=$BASE/flatpak/
SuggestRemoteName=bifrossh
Homepage=https://github.com/AalmanSadath/BifroSSH
Icon=https://raw.githubusercontent.com/AalmanSadath/BifroSSH/main/src-tauri/icons/128x128.png
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey=$key_b64
EOT

# The key travels inside the file, so adding the repository is one download
# with nothing to put in /etc/apt/keyrings first, and the key is trusted for
# this repository only. deb822 continues a field with a leading space and
# writes an empty line as " .".
{
  cat <<EOT
Types: deb
URIs: $BASE/apt
Suites: $SUITE
Components: $COMPONENT
Architectures: $DEB_ARCH
Signed-By:
EOT
  sed -e 's/^$/./' -e 's/^/ /' "$site/bifrossh.asc"
} > "$site/bifrossh.sources"

# repo_gpgcheck checks the metadata, gpgcheck the package itself; both are
# signed with the same key.
cat > "$site/bifrossh.repo" <<EOT
[bifrossh]
name=BifroSSH
baseurl=$BASE/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$BASE/bifrossh.asc
EOT

sed -e "s|@BASE@|$BASE|g" -e "s|@VERSION@|$version|g" -e "s|@APP_ID@|$APP_ID|g" \
  "$here/index.html.in" > "$site/index.html"

# Uploaded last of all, after everything it describes is live.
printf '%s' "$version" > "$site/published-version"
