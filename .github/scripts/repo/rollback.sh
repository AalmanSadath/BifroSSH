#!/usr/bin/env bash
# Makes an earlier release the current one in all three repositories.
#
#   rollback.sh VERSION SITE
#
# VERSION has to be one the repositories still keep (the last RETENTION).
# Flatpak gets a new commit carrying that release's tree, so every client
# moves back on its next update. apt and dnf lose every package newer than
# VERSION: dnf follows on `dnf distro-sync`, while apt never downgrades on
# its own and a user who already upgraded runs `apt install bifrossh=VERSION`.
#
# Run descriptors.sh with the same VERSION afterwards, and upload with
# ALLOW_SHRINK=1, since the package pools shrink by design.
source "$(dirname "$0")/common.sh"

version="$1" site="$2"
need GPG_FINGERPRINT
subject="$(flatpak_subject "$version")"

# Every package dropped here is still cached at the edge for a year under
# its name. Should that version ever be published again, the cache would
# hand out the old bytes against the new index, so purge.sh evicts these
# too. The leading dot keeps the list out of the upload.
dropped="$site/.purge"
mkdir -p "$site"
: > "$dropped"

newer_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# ── Flatpak
store="$site/flatpak"
seed_flatpak "$store"
refs="$(ostree --repo="$store" refs | grep '^app/' || true)"
[ -n "$refs" ] || die "the published Flatpak repository has no app ref"
while read -r ref; do
  [ -n "$ref" ] || continue
  head="$(ostree --repo="$store" rev-parse "$ref")"
  commit="$(ostree --repo="$store" log "$ref" | awk -v s="$subject" '
    /^commit / {c = $2}
    {line = $0; sub(/^ +/, "", line)}
    line == s {print c; exit}')"
  [ -n "$commit" ] || die "$ref keeps no commit for $version; the last $RETENTION releases are kept"
  if [ "$commit" = "$head" ]; then
    echo "$ref is already at $version"
    continue
  fi
  # On top of the head rather than moving the ref back: a client only
  # follows a ref forward, so the old tree has to arrive as a new commit.
  echo "$ref: committing the tree of ${commit:0:12} on top of ${head:0:12}"
  flatpak build-commit-from "${FLATPAK_SIGN[@]}" \
    --src-ref="$commit" \
    --subject="$subject" \
    --timestamp=NOW \
    --no-update-summary \
    "$store" "$ref"
done <<< "$refs"
finish_flatpak "$store"

# ── apt
apt="$site/apt"
seed_apt "$apt"
found=""
for f in "$apt"/pool/*/*/*/*.deb; do
  v="$(dpkg-deb -f "$f" Version)"
  if [ "$v" = "$version" ]; then
    found=1
  elif newer_than "$v" "$version"; then
    echo "  apt: dropping $v"
    echo "apt/${f#"$apt"/}" >> "$dropped"
    rm -f "$f"
  fi
done
[ -n "$found" ] || die "the apt repository keeps no $version"
index_apt "$apt"

# ── rpm
rpm="$site/rpm"
seed_rpm "$rpm"
found=""
for f in "$rpm"/Packages/*.rpm; do
  v="$(rpm -qp --qf '%{VERSION}' "$f" 2>/dev/null)"
  if [ "$v" = "$version" ]; then
    found=1
  elif newer_than "$v" "$version"; then
    echo "  rpm: dropping $v"
    echo "rpm/${f#"$rpm"/}" >> "$dropped"
    rm -f "$f"
  fi
done
[ -n "$found" ] || die "the rpm repository keeps no $version"
index_rpm "$rpm"
