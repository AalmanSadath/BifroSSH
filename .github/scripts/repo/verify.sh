#!/usr/bin/env bash
# Reads the published repositories back over the public URL and checks that
# each serves VERSION, signed.
#
#   verify.sh VERSION
#
# The only check that covers the upload itself: every step before it can
# pass while the bucket serves something a client cannot use. It runs after
# the purge, so it also sees what the edge hands out.
source "$(dirname "$0")/common.sh"

version="$1"
work="$(mktemp -d)"

fetch_pointer "$BASE/published-version" "$work/published-version" || die "published-version is missing"
got="$(cat "$work/published-version")"
[ "$got" = "$version" ] || die "published-version says $got, expected $version"

fetch_pointer "$BASE/bifrossh.gpg" "$work/key.gpg" || die "bifrossh.gpg is missing"
for f in bifrossh.flatpakrepo "$APP_ID.flatpakref" bifrossh.asc bifrossh.repo bifrossh.sources index.html; do
  fetch_pointer "$BASE/$f" "$work/$f" || die "$f is missing"
done

# ── Flatpak: the summary and the app commit both verify, and the commit is
# this release.
ref="app/$APP_ID/x86_64/$FLATPAK_BRANCH"
ostree --repo="$work/flatpak" init --mode=archive-z2
ostree --repo="$work/flatpak" remote add \
  --set=gpg-verify=true --set=gpg-verify-summary=true \
  --gpg-import="$work/key.gpg" published "$BASE/flatpak/"
ostree --repo="$work/flatpak" remote refs published | grep -qx "published:$ref" \
  || die "the Flatpak summary does not list $ref"
ostree --repo="$work/flatpak" pull --commit-metadata-only published "$ref"
ostree --repo="$work/flatpak" show "published:$ref" | grep -qF "$(flatpak_subject "$version")" \
  || die "the Flatpak head is not $version: $(ostree --repo="$work/flatpak" show "published:$ref")"
echo "flatpak: $ref is $version, signed"

# ── apt: InRelease verifies, Packages matches it, and its newest version is
# this release.
fetch_pointer "$BASE/apt/dists/$SUITE/InRelease" "$work/InRelease" || die "InRelease is missing"
gpgv --keyring "$work/key.gpg" "$work/InRelease" 2> "$work/gpgv.log" \
  || { cat "$work/gpgv.log" >&2; die "InRelease does not verify"; }
want="$(awk '/^SHA256:/ {s=1; next} /^[^ ]/ {s=0} s && $3 == "main/binary-amd64/Packages" {print $1}' "$work/InRelease")"
[ -n "$want" ] || die "InRelease lists no Packages index"
# By hash, the way apt fetches it.
fetch "$BASE/apt/$APT_BINARY_DIR/by-hash/SHA256/$want" "$work/Packages"
echo "$want  $work/Packages" | sha256sum -c --quiet || die "the published Packages does not match InRelease"
newest="$(awk '/^Version:/ {print $2}' "$work/Packages" | sort -V | tail -1)"
[ "$newest" = "$version" ] || die "the newest apt package is $newest, expected $version"
echo "apt: newest is $newest of $(grep -c '^Package:' "$work/Packages"), signed"

# ── rpm: repomd.xml verifies, and the newest package it lists is this
# release.
fetch_pointer "$BASE/rpm/repodata/repomd.xml" "$work/repomd.xml" || die "repomd.xml is missing"
fetch_pointer "$BASE/rpm/repodata/repomd.xml.asc" "$work/repomd.xml.asc" || die "repomd.xml.asc is missing"
gpgv --keyring "$work/key.gpg" "$work/repomd.xml.asc" "$work/repomd.xml" 2> "$work/gpgv.log" \
  || { cat "$work/gpgv.log" >&2; die "repomd.xml does not verify"; }
href="$(rpm_primary_href "$work/repomd.xml")"
fetch "$BASE/rpm/$href" "$work/primary.xml.gz"
newest="$(zcat "$work/primary.xml.gz" | rpm_primary_list | awk '{print $1}' \
  | sed -E 's|^Packages/.*-([^-]+)-[^-]+\.[^.]+\.rpm$|\1|' | sort -V | tail -1)"
[ "$newest" = "$version" ] || die "the newest rpm is $newest, expected $version"
echo "rpm: newest is $newest, signed"

echo "verified $version at $BASE"
