"""Write forge-manifest.json into a staged plugin folder.

Usage:  python tools/make_manifest.py "STAGE/Nexus Mods"

The manifest lists path, size and SHA-256 of every file in the folder, and the
backend checks the installed copy against it at start
(py_modules/forge_integrity.py, which this uses, so the writer and the
checker cannot drift apart). The zip must store it FIRST: Decky extracts in
zip order and stops at the first file Windows refuses, so only a manifest
written before everything else survives a copy that stopped part-way.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "py_modules"))
import forge_integrity  # noqa: E402


def write(folder: str) -> str:
    with open(os.path.join(folder, "package.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    manifest = forge_integrity.build_manifest(folder, version)
    path = os.path.join(folder, forge_integrity.MANIFEST)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write("\n")
    return path


if __name__ == "__main__":
    print(write(sys.argv[1]))
