#!/usr/bin/env bash
# Adds a freshly built Flatpak to the published history and writes the
# single-file bundle for the GitHub release.
#
#   stage-flatpak.sh BUILT_REPO SITE VERSION OUT
#
# BUILT_REPO is the unsigned repository flatpak-builder exported. The store
# under SITE/flatpak is seeded from the published one, the new build lands
# as a signed commit on top of each ref, and the result is pruned and
# checked. OUT receives bifrossh.flatpak.
source "$(dirname "$0")/common.sh"

built="$1" site="$2" version="$3" out="$4"
need GPG_FINGERPRINT
store="$site/flatpak"

# upload-artifact and tar both drop empty directories, and ostree opendir()s
# these when listing refs.
mkdir -p "$built"/refs/heads "$built"/refs/mirrors "$built"/refs/remotes \
  "$built"/state "$built"/tmp/cache "$built"/extensions

seed_flatpak "$store"

# Only the app. flatpak-builder also exports a .Debug runtime, which no one
# installs from here and which would multiply the size of every release
# kept.
refs="$(ostree --repo="$built" refs | grep '^app/' || true)"
[ -n "$refs" ] || die "$built holds no app ref"

# `ostree pull --mirror` would point each ref at the build's own commit,
# which has no parent: the seeded history would become unreachable and the
# prune would delete it. build-commit-from lands the same tree as a new
# commit on top of whatever the ref points at, which is what makes the
# chain, and so rollback and deltas, exist.
#
# It also signs the commit. The build ran without the key, and
# build-update-repo signs only the summary, while a client verifies the
# commit it pulls.
#
# A re-run for a version already published finds the same tree and commits
# nothing.
while read -r ref; do
  [ -n "$ref" ] || continue
  echo "committing $ref"
  flatpak build-commit-from "${FLATPAK_SIGN[@]}" \
    --src-repo="$built" --src-ref="$ref" \
    --subject="$(flatpak_subject "$version")" \
    --timestamp=NOW \
    --no-update-summary \
    "$store" "$ref"
done <<< "$refs"

finish_flatpak "$store"

# Built from the merged, signed store, so the file on the release page is the
# commit the repository serves. --repo-url and --gpg-keys together make it
# more than a one-off install: flatpak configures the origin remote from
# them, so an app installed from the file updates from the repository with
# signatures checked. One without the other would be an origin whose updates
# can never verify.
mkdir -p "$out"
gpg --batch --export "$GPG_FINGERPRINT" > "$out/key.gpg"
flatpak build-bundle \
  --repo-url="$BASE/flatpak/" \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  --gpg-keys="$out/key.gpg" \
  "$store" "$out/bifrossh.flatpak" "$APP_ID" "$FLATPAK_BRANCH"
rm -f "$out/key.gpg"
echo "bundle: $(du -h "$out/bifrossh.flatpak" | cut -f1)"
