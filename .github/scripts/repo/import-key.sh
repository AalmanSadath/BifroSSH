#!/usr/bin/env bash
# Imports the signing key into a private keyring for the rest of the job.
#
#   import-key.sh            (key in GPG_PRIVATE_KEY, passphrase optional in
#                             GPG_PASSPHRASE)
#
# Writes GNUPGHOME and GPG_FINGERPRINT to GITHUB_ENV for later steps.
set -euo pipefail

if [ -z "${GPG_PRIVATE_KEY:-}" ]; then
  echo "::error::FLATPAK_GPG_PRIVATE_KEY is not set. It must be the key already"
  echo "published in bifrossh.flatpakrepo: anything else locks out every install."
  exit 1
fi

export GNUPGHOME="${RUNNER_TEMP:-/tmp}/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
printf '%s\n' "$GPG_PRIVATE_KEY" | gpg --batch --import

# flatpak, ostree, apt-ftparchive's caller and rpmsign all call gpg without a
# passphrase argument. Loopback pinentry plus a primed agent lets a
# protected key sign unattended; an unprotected key ignores both. The cache
# outlives the whole staging run, which takes minutes, not the default ten.
printf '%s\n' allow-loopback-pinentry "default-cache-ttl 7200" "max-cache-ttl 7200" \
  >> "$GNUPGHOME/gpg-agent.conf"
echo "pinentry-mode loopback" >> "$GNUPGHOME/gpg.conf"
gpgconf --kill gpg-agent || true

fpr="$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')"
if [ -n "${GPG_PASSPHRASE:-}" ]; then
  echo test | gpg --batch --yes --pinentry-mode loopback \
    --passphrase "$GPG_PASSPHRASE" --local-user "$fpr" --sign --output /dev/null
fi
# Proves the key signs before any build output is spent on it.
echo test | gpg --batch --yes --local-user "$fpr" --sign --output /dev/null

{
  echo "GNUPGHOME=$GNUPGHOME"
  echo "GPG_FINGERPRINT=$fpr"
} >> "${GITHUB_ENV:-/dev/null}"
echo "signing key $fpr ready"
