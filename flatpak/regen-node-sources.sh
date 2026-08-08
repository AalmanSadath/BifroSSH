#!/usr/bin/env bash
#
# Regenerates flatpak/node-sources.json from package-lock.json.
#
# Wraps flatpak-node-generator because calling it directly in a working tree
# silently produces a manifest missing most of its packages. The generator
# decides whether a package is a local directory or a registry tarball with
#
#     if 'node_modules' not in package_json_path.parents and package_json_path.exists()
#
# (providers/npm.py). Path.parents yields Path objects, so comparing a str
# against them is always False and the first clause is always true. Every
# package whose node_modules/<pkg>/package.json exists on disk is therefore
# treated as a local source and no tarball is emitted for it. Installed deps
# are exactly the ones that get dropped, so the damage scales with how
# complete your install is, and the tool reports success either way.
#
# Running against a directory holding only the two manifests makes those
# node_modules paths not exist, which is the condition the check meant to test.
set -euo pipefail

cd "$(dirname "$0")/.."
out="flatpak/node-sources.json"

if ! command -v flatpak-node-generator >/dev/null; then
  echo "flatpak-node-generator not found. Install it with:" >&2
  echo '  pipx install "git+https://github.com/flatpak/flatpak-builder-tools#subdirectory=node"' >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# package.json travels too: the lockfile's root entry is a local source, and
# the generator fails outright when it cannot find it.
cp package.json package-lock.json "$work/"
(cd "$work" && flatpak-node-generator npm package-lock.json -o sources.json)
cp "$work/sources.json" "$out"

# The same check the release workflow runs, so a bad manifest is caught here
# rather than after a push.
python3 - "$out" <<'PY'
import json, sys

sources = open(sys.argv[1]).read()
lock = json.load(open('package-lock.json'))
missing = sorted(
    f"{path.split('node_modules/')[-1]}@{pkg['version']}"
    for path, pkg in lock['packages'].items()
    if path.startswith('node_modules/')
    and pkg.get('resolved', '').endswith('.tgz')
    and pkg['resolved'] not in sources
)
if missing:
    print(f'{sys.argv[1]} is still missing {len(missing)} package(s):', file=sys.stderr)
    for name in missing[:20]:
        print(f'  {name}', file=sys.stderr)
    sys.exit(1)

tarballs = sum(
    1 for e in json.loads(sources)
    if e.get('type') == 'file' and e.get('url', '').endswith('.tgz')
)
print(f'{sys.argv[1]}: {tarballs} tarballs, covers package-lock.json')
PY
