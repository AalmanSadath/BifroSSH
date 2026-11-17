#!/usr/bin/env bash
# Checks that every file carrying the desktop version carries the same one.
#
#   check-versions.sh [EXPECTED]
#
# EXPECTED, when given, must match too: the release passes its tag, the
# nightly the version it just wrote. Prints the version and, under Actions,
# writes it to $GITHUB_OUTPUT as `version`.
#
# AppStream takes the version from the metainfo, not the git tag, so tagging
# without adding a <release> entry ships an app that updates correctly and
# then reports the wrong version: a quiet failure that is easy to make and
# annoying to diagnose.
# No pipefail: grep | head -1 below would die of SIGPIPE.
set -eu

expected="${1:-}"
cd "$(dirname "$0")/../.."
META="flatpak/io.github.aalmansadath.bifrossh.metainfo.xml"

# AppStream orders <releases> newest first and every entry here shares the
# same date, so document order is the only usable signal. Taking the first
# entry matches how the file is written and maintained.
meta_ver=$(grep -o '<release version="[^"]*"' "$META" \
  | head -1 | sed -E 's/.*version="([^"]*)".*/\1/')
cargo_ver=$(awk -F'"' '/^\[package\]/{p=1} p && /^version[[:space:]]*=/{print $2; exit}' src-tauri/Cargo.toml)
tauri_ver=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' src-tauri/tauri.conf.json \
  | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
npm_ver=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' package.json \
  | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
# The root version, which is the first one in the file, after "name". npm ci
# does not object to this being stale, so nothing else catches it: the lock
# sat on 0.12.0 through the whole of 0.13.0.
lock_ver=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' package-lock.json \
  | head -1 | sed -E 's/.*"([^"]*)"$/\1/')

echo "metainfo (newest release): $meta_ver"
echo "src-tauri/Cargo.toml:      $cargo_ver"
echo "src-tauri/tauri.conf.json: $tauri_ver"
echo "package.json:              $npm_ver"
echo "package-lock.json:         $lock_ver"

fail=0
for v in "$cargo_ver" "$tauri_ver" "$npm_ver" "$lock_ver"; do
  if [ "$v" != "$meta_ver" ]; then
    echo "::error::Version mismatch between metainfo, Cargo.toml, tauri.conf.json, package.json and package-lock.json"
    fail=1
    break
  fi
done

if [ -n "$expected" ]; then
  echo "expected:                  $expected"
  if [ "$expected" != "$meta_ver" ]; then
    echo "::error::Expected version $expected, but the files say $meta_ver. A release needs a <release> entry in $META, not just a tag."
    fail=1
  fi
fi

[ "$fail" -eq 0 ] && echo "versions agree"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "version=$meta_ver" >> "$GITHUB_OUTPUT"
exit $fail
