#!/usr/bin/env bash
# Uploads SITE to the bucket.
#
#   upload.sh SITE
#
# Needs the `r2:` remote configured through RCLONE_CONFIG_R2_* and the bucket
# name in BUCKET. ALLOW_SHRINK=1 lets the apt and rpm package counts drop
# below half of what is published, which only a rollback should do.
#
# Two kinds of file, and the cache rules on the zone are written to match:
#
#   content   named for its bytes, never rewritten: Flatpak objects, deltas
#             and summaries, the apt pool and by-hash indexes, the rpm
#             packages and every repodata file but repomd.xml. A year,
#             immutable. A hit at the edge is never a billed read.
#   pointers  the few files that change every release and make the content
#             reachable: Flatpak summary, refs and config, apt Release and
#             Packages, rpm repomd.xml. Sixty seconds, and purge.sh evicts
#             them from the edge after each upload.
#
# The descriptors at the root (published-version aside) are pointers too.
source "$(dirname "$0")/common.sh"

site="$1"
need BUCKET

# Quoted: these are rclone patterns, and unquoted the shell would expand
# them against the working directory first, where nullglob turns every one
# with a * in it into nothing at all.
pointer_rules=(
  '/flatpak/summary*' '/flatpak/refs/**' '/flatpak/config'
  '/apt/dists/*/InRelease' '/apt/dists/*/Release' '/apt/dists/*/Release.gpg'
  '/apt/dists/*/*/binary-*/Packages' '/apt/dists/*/*/binary-*/Packages.gz'
  '/rpm/repodata/repomd.xml' '/rpm/repodata/repomd.xml.asc'
)

# --filter rules are first match in the order given. Mixing --include and
# --exclude leaves the order to rclone, so which files a phase touches would
# be a guess.
pointers=()
# tmp, state and .lock are ostree's working files, not part of what it serves.
content=(--filter "- /flatpak/tmp/**" --filter "- /flatpak/state/**" --filter "- /flatpak/.lock")
for rule in "${pointer_rules[@]}"; do
  pointers+=(--filter "+ $rule")
  content+=(--filter "- $rule")
done
pointers+=(--filter "- **")
# Root files are the descriptors, uploaded last.
content+=(--filter "- /*" --filter "+ **")

# Objects are content addressed: a matching name means matching bytes, so
# existence is all there is to compare. Without --size-only rclone compares
# modification times, reads them from the listing rather than the metadata it
# stored, decides every object differs, and uploads the whole store again.
content+=(--size-only)

common=(--transfers=32 --checkers=32 --fast-list --retries=3 --stats-one-line)
immutable=(--header-upload "Cache-Control: public, max-age=31536000, immutable")
mutable=(--header-upload "Cache-Control: public, max-age=60")

# The prune deletes whatever the bucket has and the site does not, so a site
# that came out wrong would empty the bucket rather than fail. The stage
# scripts prove each store complete; this compares it with what it replaces.
# Half is loose on purpose: a lower RETENTION legitimately shrinks a store.
guard() {
  local prefix="$1" here there
  here="$(find "$site/$prefix" -type f 2>/dev/null | wc -l)"
  # pipefail would fail the substitution on a prefix that does not exist
  # yet; on a fresh bucket that is zero, not an error.
  there="$(rclone lsf --files-only -R "r2:$BUCKET/$prefix" 2>/dev/null | wc -l || true)"
  echo "$prefix: $here here, $there published"
  if [ "$there" -gt 0 ] && [ "$here" -lt $((there / 2)) ]; then
    die "$prefix has $here files against $there published; refusing to upload"
  fi
}
guard flatpak/objects
if [ "${ALLOW_SHRINK:-}" != 1 ]; then
  guard apt/pool
  guard rpm/Packages
fi

# Three passes rather than one sync, and the order is the point. A client
# that reads a new pointer naming content not yet uploaded sees a broken
# repository, so content goes first, the pointers that make it reachable
# second, and only then is anything deleted.
echo "::group::content"
rclone copy "$site" "r2:$BUCKET" "${common[@]}" "${immutable[@]}" "${content[@]}"
echo "::endgroup::"

# --ignore-times: these change every release and can come out the same size.
echo "::group::pointers"
rclone copy "$site" "r2:$BUCKET" "${common[@]}" "${mutable[@]}" --ignore-times "${pointers[@]}"
echo "::endgroup::"

# The same filters and header as the content pass. sync uploads as well as
# deletes, and an upload here without the header would strip Cache-Control
# from whatever it touched. Files outside the filters, the pointers and the
# descriptors, are never deleted.
echo "::group::prune"
rclone sync "$site" "r2:$BUCKET" "${common[@]}" "${immutable[@]}" "${content[@]}" --delete-after
echo "::endgroup::"

# Descriptors last, and published-version last of all: it says the release
# is out, so nothing it describes may still be on its way.
# Dot files at the root are notes between the scripts, not part of the site.
rclone copy "$site" "r2:$BUCKET" "${common[@]}" "${mutable[@]}" --ignore-times \
  --filter "- /.*" --filter "- /published-version" --filter "+ /*" --filter "- **"
rclone copy "$site" "r2:$BUCKET" "${common[@]}" --ignore-times \
  --header-upload "Cache-Control: no-store" \
  --filter "+ /published-version" --filter "- **"

echo "uploaded to $BUCKET"
