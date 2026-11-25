#!/bin/sh
# Package the built plugin for the fork's update channel. Writes to OUT:
#   Nexus-Mods.zip                the newest build (update.json points here)
#   update.json                   what the updater reads
#   Nexus-Mods-<version>.zip      the same bytes under a name that stays put
#   update-<version>.json         points at that copy, so the panel's
#                                 "Reinstall" can fetch THIS build even after
#                                 a newer one is published
# All four go on the top of the "release" branch of M2ljay/Eternal-Forge
# (older Nexus-Mods-*.zip / update-*.json stay there).
#
# The zip carries forge-manifest.json (path, size, sha256 of every file),
# stored first; the backend checks the installed copy against it at start.
#
# The zip holds ONE folder, package.json's "pluginFolder" ("Nexus Mods"),
# while plugin.json's name is "Forge". Decky keys settings, data and logs by
# that folder, so keeping it is what keeps the user's API key and mod state
# across the rename. tools/checkzip.py refuses a zip that gets this wrong.
set -e
OUT=${1:?usage: make_release.sh OUT_DIR [notes]}
NOTES=${2:-}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)  # the zip is written from another directory
HERE=$(cd "$(dirname "$0")/.." && pwd)
FOLDER=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pluginFolder'])" "$HERE/package.json")
ARTIFACT="https://raw.githubusercontent.com/M2ljay/Eternal-Forge/release/Nexus-Mods.zip"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/$FOLDER/py_modules" "$STAGE/$FOLDER/dist" "$OUT"
cp "$HERE/main.py" "$HERE/package.json" "$HERE/plugin.json" "$HERE/LICENSE" "$HERE/README.md" "$STAGE/$FOLDER/"
cp "$HERE/dist/index.js" "$STAGE/$FOLDER/dist/"
find "$HERE/py_modules" -maxdepth 1 -type f \( -name '*.py' -o -name '*.json' \) -exec cp {} "$STAGE/$FOLDER/py_modules/" \;
mkdir -p "$STAGE/$FOLDER/py_modules/_stdlib_compat"
cp "$HERE/py_modules/_stdlib_compat/"*.py "$HERE/py_modules/_stdlib_compat/README.md" "$STAGE/$FOLDER/py_modules/_stdlib_compat/"
find "$STAGE" -name __pycache__ -prune -exec rm -rf {} +
python3 "$HERE/tools/make_manifest.py" "$STAGE/$FOLDER" >/dev/null
rm -f "$OUT/Nexus-Mods.zip"
# Manifest first, then everything else: Decky extracts in zip order.
(cd "$STAGE" && TZ=UTC find "$FOLDER" -exec touch -t 202601010000 {} + \
  && zip -qX "$OUT/Nexus-Mods.zip" "$FOLDER/forge-manifest.json" \
  && zip -qrX "$OUT/Nexus-Mods.zip" "$FOLDER" -x "$FOLDER/forge-manifest.json")
rm -rf "$STAGE"
python3 "$HERE/tools/checkzip.py" "$OUT/Nexus-Mods.zip"
VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$HERE/package.json")
HASH=$(sha256sum "$OUT/Nexus-Mods.zip" | cut -d' ' -f1)
PINNED_ZIP="Nexus-Mods-$VERSION.zip"
cp "$OUT/Nexus-Mods.zip" "$OUT/$PINNED_ZIP"
PINNED_ARTIFACT="https://raw.githubusercontent.com/M2ljay/Eternal-Forge/release/$PINNED_ZIP"
python3 - "$OUT" "$VERSION" "$HASH" "$NOTES" "$ARTIFACT" "$PINNED_ARTIFACT" <<'PY'
import json, os, sys
out, version, sha, notes, artifact, pinned = sys.argv[1:7]
def put(name, url):
    with open(os.path.join(out, name), "w") as f:
        json.dump({"version": version, "hash": sha, "artifact": url, "notes": notes}, f, indent=1)
put("update.json", artifact)
put(f"update-{version}.json", pinned)
PY
echo "$VERSION $HASH"
