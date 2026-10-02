#!/usr/bin/env bash
# Signs an .rpm and adds it to the published dnf repository.
#
#   stage-rpm.sh RPM SITE OUT
#
# The packages under SITE/rpm are seeded from the published ones, the new
# package is signed and added, the set is trimmed to RETENTION versions, and
# the metadata is written and signed. OUT receives the signed package, which
# is what the GitHub release carries, so the file there and the one dnf
# installs are the same bytes.
source "$(dirname "$0")/common.sh"

file="$1" site="$2" out="$3"
need GPG_FINGERPRINT
rpm="$site/rpm"

seed_rpm "$rpm"
dest="$(add_rpm "$rpm" "$file")"
prune_rpms "$rpm"
[ -f "$dest" ] || die "$(basename "$dest") was pruned as older than every version kept"
index_rpm "$rpm"

# Under the name the build gave it, which is the name every earlier release
# carried.
mkdir -p "$out"
cp "$dest" "$out/$(basename "$file")"
