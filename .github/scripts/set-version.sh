#!/usr/bin/env bash
# Writes a build's version into every file that carries one, for a nightly.
#
#   set-version.sh VERSION DATE [ANDROID_VERSION]
#
# VERSION is the desktop version as semver (0.18.2-nightly.20261118), DATE
# the build date as YYYYMMDD, ANDROID_VERSION the Android line's own version
# (0.4.3-nightly.20261118). Run from anywhere inside the checkout; the result
# is built and thrown away, never committed.
#
# sed and awk only, no jq: this runs on the Ubuntu runner, under Git Bash on
# Windows, and inside the Flatpak builder's container, and those two do not
# promise jq.
set -euo pipefail

version="${1:?usage: set-version.sh VERSION DATE [ANDROID_VERSION]}"
date="${2:?usage: set-version.sh VERSION DATE [ANDROID_VERSION]}"
android="${3:-}"

semver='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
[[ "$version" =~ $semver ]] || { echo "::error::not a semver version: $version" >&2; exit 1; }
[[ -z "$android" || "$android" =~ $semver ]] || { echo "::error::not a semver version: $android" >&2; exit 1; }
[[ "$date" =~ ^[0-9]{8}$ ]] || { echo "::error::date must be YYYYMMDD: $date" >&2; exit 1; }
iso="${date:0:4}-${date:4:2}-${date:6:2}"

cd "$(dirname "$0")/../.."
APP_ID=io.github.aalmansadath.bifrossh

# Rewrites the first COUNT `"version": "..."` pairs in a JSON file. For
# tauri.conf.json and package.json that is the top-level one; package-lock.json
# repeats the root version as packages[""].version, the second match.
json_version() {
  local file="$1" count="$2" new="$3"
  awk -v n="$count" -v v="$new" '
    c < n && /"version"[[:space:]]*:[[:space:]]*"[^"]*"/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" v "\"")
      c++
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

json_version src-tauri/tauri.conf.json 1 "$version"
json_version package.json 1 "$version"
json_version package-lock.json 2 "$version"

# The [package] version, not a dependency's.
awk -v v="$version" '
  /^\[/ { p = ($0 == "[package]") }
  p && !d && /^version[[:space:]]*=/ { print "version = \"" v "\""; d = 1; next }
  { print }
' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp
mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

# The lock names the crate's own version too, and every build here is
# --locked or offline, so a stale entry stops the build.
awk -v v="$version" '
  prev == "name = \"bifrossh\"" && /^version = / { print "version = \"" v "\""; prev = ""; next }
  { prev = $0; print }
' src-tauri/Cargo.lock > src-tauri/Cargo.lock.tmp
mv src-tauri/Cargo.lock.tmp src-tauri/Cargo.lock

# AppStream reads the version from the newest <release>, so the nightly gets
# one of its own, first, marked as a development build.
meta="flatpak/${APP_ID}.metainfo.xml"
awk -v v="$version" -v d="$iso" '
  { print }
  !done && /<releases>/ { print "    <release version=\"" v "\" date=\"" d "\" type=\"development\"/>"; done = 1 }
' "$meta" > "$meta.tmp"
mv "$meta.tmp" "$meta"

if [ -n "$android" ]; then
  json_version src-tauri/tauri.android.conf.json 1 "$android"
fi

# Read back rather than trusted: a pattern that matched nothing changes
# nothing and says nothing.
fail=0
for f in src-tauri/tauri.conf.json package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock "$meta"; do
  grep -qF "$version" "$f" || { echo "::error::$f was not given $version" >&2; fail=1; }
done
if [ -n "$android" ]; then
  grep -qF "\"$android\"" src-tauri/tauri.android.conf.json \
    || { echo "::error::tauri.android.conf.json was not given $android" >&2; fail=1; }
fi
[ "$fail" -eq 0 ]
echo "version set to $version${android:+ (Android $android)}"
