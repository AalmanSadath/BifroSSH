#!/usr/bin/env bash
# Evicts every pointer upload.sh just rewrote from Cloudflare's edge.
#
#   purge.sh SITE
#
# Needs CLOUDFLARE_API_TOKEN (Zone, Cache Purge) and CLOUDFLARE_ZONE_ID;
# without them it says so and does nothing.
#
# By URL, never "purge everything": that would drop the year-long content
# too, and every client part way through an update would fetch it again from
# R2 as billed reads. The list is read from the site rather than written out,
# so it cannot drift from what was uploaded.
source "$(dirname "$0")/common.sh"

site="$1"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ZONE_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set, skipping the purge"
  echo "Clients may see the previous release until the edge copy expires."
  exit 0
fi

list="$(mktemp)"
{
  # The root and index.html are separate cache entries even though the
  # rewrite rule serves one from the other: the key is the URL requested.
  echo ""
  ( cd "$site" && find . -maxdepth 1 -type f -not -name '.*' -printf '%P\n' )
  ( cd "$site" && find flatpak -maxdepth 1 -type f \( -name 'summary*' -o -name config \) )
  ( cd "$site" && find flatpak/refs -type f 2>/dev/null || true )
  ( cd "$site" && find apt/dists -type f -not -path '*/by-hash/*' 2>/dev/null || true )
  ( cd "$site" && find rpm/repodata -maxdepth 1 -name 'repomd.xml*' 2>/dev/null || true )
  # Packages a rollback removed; see rollback.sh.
  if [ -f "$site/.purge" ]; then cat "$site/.purge"; fi
} | sed "s|^|$BASE/|" | sort -u > "$list"

echo "::group::purging $(wc -l < "$list") URL(s)"
cat "$list"
echo "::endgroup::"

# 30 URLs a request outside Enterprise; a longer list is refused whole.
split -l 30 "$list" "$list.chunk-"
for chunk in "$list".chunk-*; do
  body="$(jq -Rsc 'split("\n") | map(select(length > 0)) | {files: .}' < "$chunk")"
  # Not -f: it would hide the API's error body, the only place that says why.
  response="$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$body")"
  if ! jq -e '.success' > /dev/null <<< "$response"; then
    echo "$response" | jq . >&2 || echo "$response" >&2
    die "cache purge failed"
  fi
  echo "purged $(wc -l < "$chunk") URL(s)"
done
