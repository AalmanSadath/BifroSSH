# shellcheck shell=bash
# Sourced by the other scripts in this directory, never run on its own.
#
# Three package repositories live in one Cloudflare R2 bucket behind
# R2_PUBLIC_BASE, and every script here builds or checks one part of it:
#
#   /flatpak/   signed OSTree repository (archive-z2)
#   /apt/       signed apt repository, suite "stable", component "main"
#   /rpm/       signed dnf repository, packages signed as well
#   /           descriptors: .flatpakrepo, .flatpakref, keys, .repo,
#               .sources, index.html, and published-version
#
# The cache rules on the zone are written against exactly these paths, so a
# change to the layout has to be made there too.
#
# Nothing in here holds a bucket credential. Seeding reads the published
# repositories back over their public URL, the same way a client would, so
# the job that holds the signing key never also holds write access to the
# bucket.

set -euo pipefail
# A glob that matches nothing iterates nothing, rather than once over the
# pattern itself.
shopt -s nullglob
# Without this, set -e stops at the edge of every $( ): a failure inside one,
# a die included, only ends the substitution, and the script carries on with
# whatever it printed, usually nothing.
shopt -s inherit_errexit

# shellcheck disable=SC2034 # used by the scripts that source this
APP_ID=io.github.aalmansadath.bifrossh
# The branch flatpak-builder exports to when the manifest names none.
# shellcheck disable=SC2034
FLATPAK_BRANCH=master
SUITE=stable
COMPONENT=main
DEB_ARCH=amd64

die() { echo "::error::$*" >&2; exit 1; }

need() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "$v is not set"
  done
}

need R2_PUBLIC_BASE
BASE="${R2_PUBLIC_BASE%/}"

# How many releases each repository keeps: parents per Flatpak ref, and
# package versions in the apt pool and the rpm directory. A repository
# variable is free text, and this value reaches ostree's --depth, which
# silently misreads some bad values rather than rejecting them, so it is
# checked here. 0 would mean "no parents at all" to ostree.
RETENTION="${RETENTION:-10}"
case "$RETENTION" in
  ''|*[!0-9]*) die "RETENTION must be a positive integer, got '$RETENTION'" ;;
esac
[ "$RETENTION" -ge 1 ] || die "RETENTION must be at least 1, got $RETENTION"

# ostree counts parents, not commits: depth N keeps the head and N more. The
# seed and the prune both use this, so the Flatpak history holds RETENTION
# releases like the apt and rpm pools do. They also have to agree with each
# other; see seed_flatpak.
FLATPAK_DEPTH=$((RETENTION - 1))

# Whether version $1 is newer than $2.
version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# Whether a published file exists. Only a 404 means "not yet"; any other
# failure stops the run. Reading a network error as "nothing published"
# would build a fresh repository, and the upload would then delete the real
# one to match it.
published() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$1")" || die "could not reach $1"
  case "$code" in
    200) return 0 ;;
    404) return 1 ;;
    *) die "$1 answered $code" ;;
  esac
}

# A file that changes every release, fetched past the edge cache. The cache
# key includes the query string, so a unique one always reaches the bucket.
# Seeding from a stale index would leave the newest release out of the new
# one, and the prune would then delete it.
fetch_pointer() {
  local url="$1" out="$2" code
  code="$(curl -sS -o "$out" -w '%{http_code}' "${url}?fresh=$(date +%s%N)")" \
    || die "could not reach $url"
  case "$code" in
    200) return 0 ;;
    404) rm -f "$out"; return 1 ;;
    *) die "$url answered $code" ;;
  esac
}

# A content-addressed or versioned file: its name fixes its bytes, so the
# cached copy is as good as the bucket's.
fetch() {
  mkdir -p "$(dirname "$2")"
  curl -fsSL -o "$2" "$1" || die "could not download $1"
}

# Flatpak signing flags, for the scripts that sign. GNUPGHOME is set by the
# workflow when the key is imported into a private keyring; flatpak does not
# read it on its own.
FLATPAK_SIGN=()
if [ -n "${GPG_FINGERPRINT:-}" ]; then
  FLATPAK_SIGN=("--gpg-sign=$GPG_FINGERPRINT")
  if [ -n "${GNUPGHOME:-}" ]; then FLATPAK_SIGN+=("--gpg-homedir=$GNUPGHOME"); fi
fi

gpg_sign() {
  need GPG_FINGERPRINT
  gpg --batch --yes --local-user "$GPG_FINGERPRINT" --digest-algo SHA512 "$@"
}

# Deletes all but the newest $RETENTION files from a list of
# "version<TAB>path" lines on stdin.
keep_newest() {
  local versions
  versions="$(sort -t "$(printf '\t')" -k1,1V)"
  [ -n "$versions" ] || return 0
  printf '%s\n' "$versions" | head -n "-$RETENTION" | while IFS="$(printf '\t')" read -r ver path; do
    echo "  dropping $ver ($(basename "$path")), outside the last $RETENTION"
    rm -f "$path"
  done
}

# ── Flatpak ──────────────────────────────────────────────────────────────

# Creates the store at $1 and seeds it with what is already published,
# $RETENTION commits deep per ref.
#
# Keeping parents is what makes rollback possible, for a user with
# `flatpak update --commit` and for the rollback workflow, and it gives the
# static deltas something to delta against.
seed_flatpak() {
  local store="$1" remote_refs seeded ref
  mkdir -p "$store"
  ostree --repo="$store" init --mode=archive-z2

  if ! published "$BASE/flatpak/config"; then
    echo "no published Flatpak repository yet; starting a fresh store"
    return 0
  fi
  echo "seeding from $BASE/flatpak/"
  # --no-gpg-verify: these commits were signed on the way out and every new
  # commit is signed below; verifying here would only read our own history
  # back. verify.sh checks the signatures over the public URL.
  ostree --repo="$store" remote add --no-gpg-verify published "$BASE/flatpak/"
  remote_refs="$(ostree --repo="$store" remote refs published | wc -l)"
  echo "published repository advertises $remote_refs ref(s)"
  # --depth is not optional. It defaults to 0, "no parents", which seeds the
  # head of each ref and nothing behind it, so history would never grow past
  # two commits whatever --prune-depth says. Seeding shallower than the
  # prune depth does not retain less: it deletes the difference, because the
  # upload removes whatever the bucket has and this store does not.
  ostree --repo="$store" pull --mirror --depth="$FLATPAK_DEPTH" published
  # The remote is only how the seed was fetched. Left in, it would be
  # published as part of the repository's own config.
  ostree --repo="$store" remote delete published

  seeded="$(ostree --repo="$store" refs | wc -l)"
  if [ "$remote_refs" -gt 0 ] && [ "$seeded" -eq 0 ]; then
    die "the published repository advertises $remote_refs refs but none were seeded"
  fi
  while read -r ref; do
    [ -n "$ref" ] || continue
    echo "  seeded $ref at $(ostree --repo="$store" log "$ref" | grep -c '^commit ') commit(s)"
  done <<< "$(ostree --repo="$store" refs)"
}

# Regenerates the summary and deltas, prunes to $RETENTION commits, and
# refuses a store that is not fit to publish.
finish_flatpak() {
  local store="$1" app_refs ref
  # Deltas are generated between each head and its parent. R2 bills
  # requests rather than bytes, and an update through a delta is a handful
  # of requests where a full pull is one per object.
  need GPG_FINGERPRINT
  flatpak build-update-repo "${FLATPAK_SIGN[@]}" \
    --title=BifroSSH \
    --generate-static-deltas \
    --prune --prune-depth="$FLATPAK_DEPTH" \
    "$store"

  # A summary without the app ref is the failure that looks fine
  # everywhere: every step green, every client seeing an empty remote.
  app_refs="$(ostree --repo="$store" refs | grep -c '^app/' || true)"
  [ "$app_refs" -gt 0 ] || die "the Flatpak store has no app refs; refusing to publish"
  while read -r ref; do
    [ -n "$ref" ] || continue
    echo "$ref: $(ostree --repo="$store" log "$ref" | grep -c '^commit ') commit(s) retained"
  done <<< "$(ostree --repo="$store" refs)"

  # Walks every object reachable from every ref. A store that passes is
  # complete, whatever its object count, which is what makes it safe for
  # the upload to delete what the store no longer has.
  ostree --repo="$store" fsck
  echo "store: $(du -sm "$store" | cut -f1) MB, $(find "$store/objects" -type f | wc -l) objects"
}

# The commit message every app commit carries. The rollback workflow finds
# a release's commit by it, and `flatpak remote-info --log` shows it to a
# user choosing one to go back to.
flatpak_subject() { printf 'BifroSSH %s' "$1"; }

# ── apt ──────────────────────────────────────────────────────────────────

APT_BINARY_DIR="dists/$SUITE/$COMPONENT/binary-$DEB_ARCH"

# Downloads every package the published index lists into the pool at $1,
# checking each against the index, plus the published index files' by-hash
# copies so the previous generation stays reachable.
seed_apt() {
  local apt="$1" index sha file
  mkdir -p "$apt/$APT_BINARY_DIR"
  index="$(mktemp)"
  if ! fetch_pointer "$BASE/apt/$APT_BINARY_DIR/Packages" "$index"; then
    echo "no published apt repository yet; starting a fresh pool"
    return 0
  fi
  # One "sha256 filename" line per stanza.
  awk '/^Filename:/ {f=$2} /^SHA256:/ {s=$2} /^$/ {if (f) print s, f; f=s=""} END {if (f) print s, f}' \
    "$index" > "$index.list"
  while read -r sha file; do
    [ -n "$file" ] || continue
    case "$file" in pool/*) ;; *) die "the published index names $file, outside the pool" ;; esac
    fetch "$BASE/apt/$file" "$apt/$file"
    echo "$sha  $apt/$file" | sha256sum -c --quiet || die "$file does not match the published index"
    echo "  seeded $file"
  done < "$index.list"

  # The by-hash files the published Release names. A client that read that
  # Release a moment before this publish fetches its indexes by these
  # hashes, so they must outlive it. apt-ftparchive keeps them in place
  # (By-Hash-Keep) as long as they are here to keep, and the upload deletes
  # whatever is not.
  local release by
  release="$(mktemp)"
  if fetch_pointer "$BASE/apt/dists/$SUITE/Release" "$release"; then
    awk '/^SHA256:/ {s=1; next} /^[^ ]/ {s=0} s && $3 ~ /^main\/binary-/ {print $1, $3}' "$release" \
      | while read -r sha file; do
          by="dists/$SUITE/$(dirname "$file")/by-hash/SHA256/$sha"
          fetch "$BASE/apt/$by" "$apt/$by"
        done
  fi
}

# Moves $2 into the pool at $1 under the name apt expects, unless that
# version is already published, and prints where it is.
add_deb() {
  local apt="$1" deb="$2" pkg ver arch dest
  pkg="$(dpkg-deb -f "$deb" Package)"
  ver="$(dpkg-deb -f "$deb" Version)"
  arch="$(dpkg-deb -f "$deb" Architecture)"
  [ "$arch" = "$DEB_ARCH" ] || die "$deb is for $arch, this repository serves $DEB_ARCH"
  dest="$apt/pool/$COMPONENT/${pkg:0:1}/$pkg/${pkg}_${ver}_${arch}.deb"
  if [ -f "$dest" ]; then
    # A published package is cached at the edge for a year by name. New
    # bytes under the same name would disagree with the cached copy, and
    # every client would fail the hash check, so the published file stays.
    echo "  $pkg $ver is already published; keeping the published package" >&2
  else
    mkdir -p "$(dirname "$dest")"
    cp "$deb" "$dest"
    echo "  added $pkg $ver" >&2
  fi
  printf '%s\n' "$dest"
}

# Trims the pool to $RETENTION versions.
prune_debs() {
  local apt="$1" f
  for f in "$apt"/pool/*/*/*/*.deb; do
    printf '%s\t%s\n' "$(dpkg-deb -f "$f" Version)" "$f"
  done | keep_newest
}

# Writes Packages, Release, InRelease and Release.gpg for the pool at $1.
index_apt() {
  local apt="$1" count
  count="$(find "$apt/pool" -name '*.deb' 2>/dev/null | wc -l)"
  [ "$count" -gt 0 ] || die "the apt pool is empty; refusing to publish"
  (
    cd "$apt"
    mkdir -p "$APT_BINARY_DIR"
    apt-ftparchive -o APT::FTPArchive::MD5=false -o APT::FTPArchive::SHA1=false \
      packages pool > "$APT_BINARY_DIR/Packages"
    gzip -9nkf "$APT_BINARY_DIR/Packages"
    # Into a temporary file: apt-ftparchive would otherwise hash the
    # half-written Release into itself.
    apt-ftparchive \
      -o APT::FTPArchive::DoByHash=true \
      -o APT::FTPArchive::By-Hash-Keep=2 \
      -o APT::FTPArchive::Release::MD5=false \
      -o APT::FTPArchive::Release::SHA1=false \
      -o APT::FTPArchive::Release::Origin=BifroSSH \
      -o APT::FTPArchive::Release::Label=BifroSSH \
      -o APT::FTPArchive::Release::Suite="$SUITE" \
      -o APT::FTPArchive::Release::Codename="$SUITE" \
      -o APT::FTPArchive::Release::Architectures="$DEB_ARCH" \
      -o APT::FTPArchive::Release::Components="$COMPONENT" \
      -o APT::FTPArchive::Release::Description="BifroSSH, GUI SSH client" \
      -o APT::FTPArchive::Release::Acquire-By-Hash=yes \
      release "dists/$SUITE" > "dists/$SUITE/Release.new"
    mv "dists/$SUITE/Release.new" "dists/$SUITE/Release"
    gpg_sign --clearsign -o "dists/$SUITE/InRelease" "dists/$SUITE/Release"
    gpg_sign --armor --detach-sign -o "dists/$SUITE/Release.gpg" "dists/$SUITE/Release"
  )
  echo "apt: $count package(s), $(grep -c '^Package:' "$apt/$APT_BINARY_DIR/Packages") in the index"
}

# ── rpm ──────────────────────────────────────────────────────────────────

# Prints "href sha256" for each package in a primary.xml read on stdin.
rpm_primary_list() {
  python3 -c '
import sys, xml.etree.ElementTree as ET
ns = {"c": "http://linux.duke.edu/metadata/common"}
for p in ET.parse(sys.stdin).getroot().findall("c:package", ns):
    print(p.find("c:location", ns).get("href"), p.find("c:checksum", ns).text)
'
}

# Prints the location of the primary metadata named by a repomd.xml file.
rpm_primary_href() {
  python3 -c '
import sys, xml.etree.ElementTree as ET
ns = {"r": "http://linux.duke.edu/metadata/repo"}
for d in ET.parse(sys.argv[1]).getroot().findall("r:data", ns):
    if d.get("type") == "primary":
        print(d.find("r:location", ns).get("href"))
' "$1"
}

# Downloads every package and metadata file the published repository has
# into $1. The previous metadata is kept so createrepo_c can retain it for
# clients that read the old repomd.xml a moment before this publish.
seed_rpm() {
  local rpm="$1" repomd href sha
  mkdir -p "$rpm/Packages" "$rpm/repodata"
  repomd="$(mktemp)"
  if ! fetch_pointer "$BASE/rpm/repodata/repomd.xml" "$repomd"; then
    echo "no published rpm repository yet; starting fresh"
    return 0
  fi
  cp "$repomd" "$rpm/repodata/repomd.xml"
  grep -o 'href="repodata/[^"]*"' "$repomd" | sed -e 's/^href="//' -e 's/"$//' | while read -r href; do
    fetch "$BASE/rpm/$href" "$rpm/$href"
  done
  href="$(rpm_primary_href "$repomd")"
  [ -n "$href" ] || die "the published repomd.xml names no primary metadata"
  zcat "$rpm/$href" | rpm_primary_list | while read -r href sha; do
    case "$href" in Packages/*) ;; *) die "the published metadata names $href, outside Packages/" ;; esac
    fetch "$BASE/rpm/$href" "$rpm/$href"
    echo "$sha  $rpm/$href" | sha256sum -c --quiet || die "$href does not match the published metadata"
    echo "  seeded $href"
  done
}

# rpmsign and rpmkeys against a throwaway database, so checking a signature
# never depends on, or changes, the keys the machine itself trusts.
RPMDB="$(mktemp -d)"
rpm_checked() {
  if [ ! -f "$RPMDB/.imported" ]; then
    need GPG_FINGERPRINT
    gpg --batch --armor --export "$GPG_FINGERPRINT" > "$RPMDB/key.asc"
    rpmkeys --dbpath "$RPMDB" --import "$RPMDB/key.asc"
    touch "$RPMDB/.imported"
  fi
  rpmkeys --dbpath "$RPMDB" --checksig "$1" | grep -q ': digests signatures OK$' \
    || die "$(basename "$1") does not carry a valid signature: $(rpmkeys --dbpath "$RPMDB" --checksig "$1")"
}

# Signs $2 and moves it into $1 under its canonical name, unless that
# version is already published, and prints where it is.
add_rpm() {
  local rpm="$1" file="$2" name dest work
  name="$(rpm -qp --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}.rpm' "$file" 2>/dev/null)"
  dest="$rpm/Packages/$name"
  if [ -f "$dest" ]; then
    # Same reason as add_deb: the published bytes are cached by name.
    echo "  $name is already published; keeping the published package" >&2
  else
    work="$(mktemp -d)"
    cp "$file" "$work/$name"
    need GPG_FINGERPRINT
    # rpm looks for gpg under its own idea of the path, misses on Ubuntu,
    # and can still exit 0; rpm_checked below is what catches that.
    rpmsign --define "__gpg $(command -v gpg)" \
      --define "_gpg_name $GPG_FINGERPRINT" \
      ${GNUPGHOME:+--define "_gpg_path $GNUPGHOME"} \
      --define "_gpg_digest_algo sha512" \
      --addsign "$work/$name" > /dev/null
    mv "$work/$name" "$dest"
    echo "  signed and added $name" >&2
  fi
  rpm_checked "$dest"
  printf '%s\n' "$dest"
}

prune_rpms() {
  local rpm="$1" f
  for f in "$rpm"/Packages/*.rpm; do
    printf '%s\t%s\n' "$(rpm -qp --qf '%{EPOCHNUM}:%{VERSION}-%{RELEASE}' "$f" 2>/dev/null)" "$f"
  done | keep_newest
}

index_rpm() {
  local rpm="$1" f count=0
  for f in "$rpm"/Packages/*.rpm; do
    rpm_checked "$f"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] || die "the rpm directory is empty; refusing to publish"
  # gz rather than the newer default, so seed_rpm can always read it back.
  # Unique names make every metadata file but repomd.xml content-addressed,
  # which is what lets the edge cache them for a year.
  createrepo_c --quiet --update --unique-md-filenames \
    --general-compress-type=gz --retain-old-md 1 "$rpm"
  gpg_sign --armor --detach-sign -o "$rpm/repodata/repomd.xml.asc" "$rpm/repodata/repomd.xml"
  echo "rpm: $count package(s)"
}
