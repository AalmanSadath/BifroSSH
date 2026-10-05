#!/usr/bin/env bash
# Fills the repositories with releases from before they existed, so going
# back a version has somewhere to go.
#
#   backfill.sh ASSETS SITE CURRENT
#
# ASSETS holds one directory per earlier release, named for its version, each
# with the release's bifrossh.flatpak, .deb and .rpm, and optionally a `date`
# file with its publish time (ISO 8601). CURRENT is the version the
# repositories serve now, which stays the newest.
#
# Releases before 0.16.1 were packaged as bifro-ssh. Their packages are
# repackaged as bifrossh, files untouched and checked to be, so that
# `apt install bifrossh=VERSION` and `dnf downgrade bifrossh` reach them.
#
# Run descriptors.sh with CURRENT afterwards, as a release does.
source "$(dirname "$0")/common.sh"

assets="$1" site="$2" current="$3"
need GPG_FINGERPRINT
work="$(mktemp -d)"
ref="app/$APP_ID/x86_64/$FLATPAK_BRANCH"

# ── What is being added, oldest first ───────────────────────────────────
versions=()
while read -r v; do
  [ -n "$v" ] || continue
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$assets/$v is not named for a version"
  version_gt "$current" "$v" || die "$v is not older than the current $current"
  bundle=("$assets/$v"/bifrossh.flatpak) debs=("$assets/$v"/*.deb) rpms=("$assets/$v"/*.rpm)
  [ "${#bundle[@]}" -eq 1 ] && [ "${#debs[@]}" -eq 1 ] && [ "${#rpms[@]}" -eq 1 ] \
    || die "$assets/$v needs one bifrossh.flatpak, one .deb and one .rpm"
  versions+=("$v")
done <<< "$(find "$assets" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V)"
[ "${#versions[@]}" -gt 0 ] || die "$assets holds no releases"
echo "backfilling ${versions[*]} beneath $current"

# The number of releases each repository should end up holding.
expected=$(( ${#versions[@]} + 1 ))
[ "$expected" -le "$RETENTION" ] || expected="$RETENTION"

# ── Repackaging ─────────────────────────────────────────────────────────

# Prints the path of $1 as a bifrossh .deb, repackaged into $2 if it was
# built as bifro-ssh.
rename_deb() {
  local in="$1" out="$2" v="$3" pkg ver tree new
  pkg="$(dpkg-deb -f "$in" Package)"
  ver="$(dpkg-deb -f "$in" Version)"
  [ "$ver" = "$v" ] || die "$(basename "$in") is version $ver, filed under $v"
  case "$pkg" in
    bifrossh) printf '%s\n' "$in"; return 0 ;;
    bifro-ssh) ;;
    *) die "$(basename "$in") is package $pkg" ;;
  esac
  tree="$work/deb-$v"
  dpkg-deb -R "$in" "$tree"
  sed -i 's/^Package: bifro-ssh$/Package: bifrossh/' "$tree/DEBIAN/control"
  # The same pair the current packages declare: dpkg swaps the old name out
  # rather than refusing two packages that both ship /usr/bin/bifrossh.
  grep -q '^Conflicts:' "$tree/DEBIAN/control" && die "$(basename "$in") already declares Conflicts"
  sed -i '/^Package:/a Conflicts: bifro-ssh\nReplaces: bifro-ssh' "$tree/DEBIAN/control"
  mkdir -p "$out"
  new="$out/bifrossh_${ver}_$(dpkg-deb -f "$in" Architecture).deb"
  # xz rather than the zstd this dpkg would default to, which older dpkg
  # cannot unpack.
  dpkg-deb --root-owner-group -Zxz -b "$tree" "$new" > /dev/null
  # Only the name changes. Anything else would make this a different release
  # wearing an old version number.
  mkdir -p "$work/deb-old-$v" "$work/deb-new-$v"
  dpkg-deb -x "$in" "$work/deb-old-$v"
  dpkg-deb -x "$new" "$work/deb-new-$v"
  diff -r "$work/deb-old-$v" "$work/deb-new-$v" > /dev/null || die "repackaging $ver changed its files"
  [ "$(dpkg-deb -f "$new" Package)" = bifrossh ] || die "repackaged $ver is not named bifrossh"
  echo "  repackaged $ver as bifrossh" >&2
  printf '%s\n' "$new"
}

# The same for an .rpm. Ubuntu has no rpmrebuild, so the package is built
# again with rpmbuild from its own payload and header: same files, modes,
# requirements and description, with nothing derived afresh.
rename_rpm() {
  local in="$1" out="$2" v="$3" name ver rel arch top payload spec new
  q() { rpm -qp --qf "$1" "$in" 2>/dev/null; }
  name="$(q '%{NAME}')" ver="$(q '%{VERSION}')" rel="$(q '%{RELEASE}')" arch="$(q '%{ARCH}')"
  [ "$ver" = "$v" ] || die "$(basename "$in") is version $ver, filed under $v"
  case "$name" in
    bifrossh) printf '%s\n' "$in"; return 0 ;;
    bifro-ssh) ;;
    *) die "$(basename "$in") is package $name" ;;
  esac
  local tag
  for tag in PRETRANS PREIN POSTIN PREUN POSTUN POSTTRANS TRIGGERSCRIPTS; do
    [ "$(q "%{$tag}")" = "(none)" ] \
      || die "$(basename "$in") has a $tag scriptlet, which this does not carry over"
  done

  top="$work/rpmbuild-$v"
  payload="$work/rpm-old-$v"
  mkdir -p "$top"/{BUILD,RPMS,SOURCES,SPECS,SRPMS} "$payload"
  ( cd "$payload" && rpm2cpio "$in" | cpio -idm --quiet )

  spec="$top/SPECS/bifrossh.spec"
  {
    echo "Name: bifrossh"
    echo "Version: $ver"
    echo "Release: $rel"
    echo "Summary: $(q '%{SUMMARY}')"
    echo "License: $(q '%{LICENSE}')"
    echo "BuildArch: $arch"
    # The requirements are copied, not worked out again on a machine that
    # is not the one the package was built for.
    echo "AutoReqProv: no"
    rpm -qp --requires "$in" 2>/dev/null | grep -v '^rpmlib(' | sed 's/^/Requires: /'
    echo "Obsoletes: bifro-ssh"
    echo
    echo "%description"
    q '%{DESCRIPTION}\n' | sed 's/%/%%/g'
    echo
    echo "%install"
    echo "mkdir -p %{buildroot}"
    echo "cp -a '$payload/.' %{buildroot}/"
    echo
    echo "%files"
    rpm -qp --qf '[%{FILEMODES:octal}\t%{FILEUSERNAME}\t%{FILEGROUPNAME}\t%{FILENAMES}\n]' "$in" 2>/dev/null \
      | while IFS="$(printf '\t')" read -r mode user group path; do
          printf '%%attr(%s,%s,%s) "%s"\n' "${mode: -4}" "$user" "$group" "$path"
        done
  } > "$spec"

  # Nothing stripped, compressed, checked or added after install: the files
  # go in exactly as the release built them.
  rpmbuild -bb --quiet \
    --define "_topdir $top" \
    --define "debug_package %{nil}" \
    --define "__os_install_post %{nil}" \
    --define "__arch_install_post %{nil}" \
    --define "_build_id_links none" \
    --define "_binary_payload w9.gzdio" \
    "$spec" > /dev/null

  new="$top/RPMS/$arch/bifrossh-$ver-$rel.$arch.rpm"
  [ -f "$new" ] || die "rpmbuild did not produce $(basename "$new")"
  mkdir -p "$work/rpm-new-$v"
  ( cd "$work/rpm-new-$v" && rpm2cpio "$new" | cpio -idm --quiet )
  diff -r "$payload" "$work/rpm-new-$v" > /dev/null || die "repackaging $ver changed its files"
  diff <(rpm -qp --requires "$in" 2>/dev/null | grep -v '^rpmlib(' | sort) \
       <(rpm -qp --requires "$new" 2>/dev/null | grep -v '^rpmlib(' | sort) > /dev/null \
    || die "repackaging $ver changed its requirements"
  mkdir -p "$out"
  cp "$new" "$out/"
  echo "  repackaged $ver as bifrossh" >&2
  printf '%s\n' "$out/$(basename "$new")"
}

# ── Flatpak ─────────────────────────────────────────────────────────────

# The live store, read for the commit that has to stay on top.
seed_flatpak "$work/current"
head_subject="$(ostree --repo="$work/current" show "$ref" | sed -n 's/^    //p' | head -1)"
[ "$head_subject" = "$(flatpak_subject "$current")" ] \
  || die "the published Flatpak head is '$head_subject', not $current"

# A fresh chain rather than the seeded one: history runs oldest first, and the
# live head has to end up on top of it, not underneath.
store="$site/flatpak"
mkdir -p "$store"
ostree --repo="$store" init --mode=archive-z2
for v in "${versions[@]}"; do
  built="$work/built-$v"
  ostree --repo="$built" init --mode=archive-z2
  flatpak build-import-bundle --no-update-summary "$built" "$assets/$v/bifrossh.flatpak" > /dev/null
  ostree --repo="$built" refs | grep -qx "$ref" || die "the $v bundle does not hold $ref"
  # The newest release the app's own metadata lists is the version it is.
  inside="$(ostree --repo="$built" cat "$ref" "/files/share/metainfo/$APP_ID.metainfo.xml" \
    | grep -o '<release version="[^"]*"' | head -1 | sed 's/.*"\(.*\)"/\1/')"
  [ "$inside" = "$v" ] || die "the bundle filed under $v is version ${inside:-unknown}"
  # The release's own date, so `flatpak remote-info --log` reads as history.
  stamp=NOW
  if [ -f "$assets/$v/date" ]; then stamp="$(cat "$assets/$v/date")"; fi
  echo "committing $v ($stamp)"
  flatpak build-commit-from "${FLATPAK_SIGN[@]}" \
    --src-repo="$built" --src-ref="$ref" \
    --subject="$(flatpak_subject "$v")" \
    --timestamp="$stamp" \
    --no-update-summary \
    "$store" "$ref"
done
# The tree users have now, as a new commit dated now: newer than the one they
# are on, so `flatpak update` takes it, and identical in content, so almost
# nothing downloads.
echo "committing $current on top"
flatpak build-commit-from "${FLATPAK_SIGN[@]}" \
  --src-repo="$work/current" --src-ref="$ref" \
  --subject="$(flatpak_subject "$current")" \
  --timestamp=NOW \
  --no-update-summary \
  "$store" "$ref"
finish_flatpak "$store"
commits="$(ostree --repo="$store" log "$ref" | grep -c '^commit ')"
[ "$commits" -eq "$expected" ] || die "the Flatpak history holds $commits releases, expected $expected"

# ── apt ─────────────────────────────────────────────────────────────────
apt="$site/apt"
seed_apt "$apt"
for v in "${versions[@]}"; do
  debs=("$assets/$v"/*.deb)
  add_deb "$apt" "$(rename_deb "${debs[0]}" "$work/debs" "$v")" > /dev/null
done
prune_debs "$apt"
index_apt "$apt"
count="$(grep -c '^Package: bifrossh$' "$apt/$APT_BINARY_DIR/Packages")"
newest="$(awk '/^Version:/ {print $2}' "$apt/$APT_BINARY_DIR/Packages" | sort -V | tail -1)"
[ "$count" -eq "$expected" ] || die "the apt index lists $count bifrossh versions, expected $expected"
[ "$newest" = "$current" ] || die "the newest apt version is $newest, not $current"

# ── rpm ─────────────────────────────────────────────────────────────────
rpm="$site/rpm"
seed_rpm "$rpm"
for v in "${versions[@]}"; do
  rpms=("$assets/$v"/*.rpm)
  add_rpm "$rpm" "$(rename_rpm "${rpms[0]}" "$work/rpms" "$v")" > /dev/null
done
prune_rpms "$rpm"
index_rpm "$rpm"
count=0
for f in "$rpm"/Packages/*.rpm; do
  [ "$(rpm -qp --qf '%{NAME}' "$f" 2>/dev/null)" = bifrossh ] || die "$(basename "$f") is not named bifrossh"
  count=$((count + 1))
done
[ "$count" -eq "$expected" ] || die "the rpm repository holds $count versions, expected $expected"

echo "backfilled: $expected releases in each repository, $current newest"
