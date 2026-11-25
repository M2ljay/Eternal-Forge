#!/bin/sh
# Package the built plugin for the fork's update channel: OUT/Nexus-Mods.zip
# and OUT/update.json, which go on the top of the "release" branch of
# M2ljay/Eternal-Forge.
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
rm -f "$OUT/Nexus-Mods.zip"
(cd "$STAGE" && TZ=UTC find "$FOLDER" -exec touch -t 202601010000 {} + && zip -qrX "$OUT/Nexus-Mods.zip" "$FOLDER")
rm -rf "$STAGE"
python3 "$HERE/tools/checkzip.py" "$OUT/Nexus-Mods.zip"
VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$HERE/package.json")
HASH=$(sha256sum "$OUT/Nexus-Mods.zip" | cut -d' ' -f1)
python3 - "$OUT/update.json" "$VERSION" "$HASH" "$NOTES" "$ARTIFACT" <<'PY'
import json, sys
path, version, sha, notes, artifact = sys.argv[1:6]
json.dump({"version": version, "hash": sha, "artifact": artifact,
           "notes": notes}, open(path, "w"), indent=1)
PY
echo "$VERSION $HASH"
