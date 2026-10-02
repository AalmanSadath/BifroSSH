#!/usr/bin/env bash
# Adds a .deb to the published apt repository.
#
#   stage-apt.sh DEB SITE OUT
#
# The pool under SITE/apt is seeded from the published one, the package is
# added, the pool is trimmed to RETENTION versions, and the indexes are
# written and signed. OUT receives the package as it is published, which is
# what the GitHub release carries.
source "$(dirname "$0")/common.sh"

deb="$1" site="$2" out="$3"
need GPG_FINGERPRINT
apt="$site/apt"

seed_apt "$apt"
dest="$(add_deb "$apt" "$deb")"
prune_debs "$apt"
[ -f "$dest" ] || die "$(basename "$dest") was pruned as older than every version kept"
index_apt "$apt"

# Under the name the build gave it, which is the name every earlier release
# carried.
mkdir -p "$out"
cp "$dest" "$out/$(basename "$deb")"
