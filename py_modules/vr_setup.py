"""Recording what an outside VR tool (MRSURVIV0R's VR HUB, UEVR, a mod's
own installer) changes in a game folder, so the plugin leaves it alone.

The VR tools have no API and no install record of their own, so the
plugin learns their files by comparison: a listing of the game folder
(size and modification time of every file) before the tool runs, another
after, and the difference is the VR setup. Each recorded file keeps a
signature (size, time, and a SHA-1 for files up to HASH_LIMIT) so the
plugin can tell later whether the file there is still the VR tool's -
a mod installed over it afterwards, or a game update, makes it something
else, and then it is no longer protected.

Pure helpers: no settings, no Decky.
"""

from __future__ import annotations

import hashlib
import os

HASH_LIMIT = 256 << 20
MAX_FILES = 400_000
# Files a game writes by itself while it runs (a test launch during the
# recording), never part of a VR setup.
_NOISE_EXTS = (".log", ".dmp", ".mdmp", ".tmp", ".nexusbak", ".nexusoff", ".bak", ".crdownload")
_NOISE_DIRS = {"logs", "log", "crashdumps", "crashes", "crash", "shadercache", "shader_cache",
               "__pycache__", "webcache", "cache"}


def _noise(rel: str) -> bool:
    low = rel.lower()
    if low.endswith(_NOISE_EXTS):
        return True
    return any(part in _NOISE_DIRS for part in low.split("/")[:-1])


def snapshot(root: str) -> dict:
    """{relative path: [size, mtime_ns]} of every file under root."""
    out = {}
    for dp, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            p = os.path.join(dp, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[os.path.relpath(p, root).replace(os.sep, "/")] = [st.st_size, st.st_mtime_ns]
            if len(out) >= MAX_FILES:
                return out
    return out


def diff(before: dict, after: dict) -> tuple:
    """(added, changed, removed) relative paths, noise left out."""
    added, changed = [], []
    for rel, sig in after.items():
        if _noise(rel):
            continue
        old = before.get(rel)
        if old is None:
            added.append(rel)
        elif list(old) != list(sig):
            changed.append(rel)
    removed = [rel for rel in before if rel not in after and not _noise(rel)]
    return sorted(added), sorted(changed), sorted(removed)


def _sha1(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def signature(path: str) -> dict:
    st = os.stat(path)
    sig = {"size": st.st_size, "mtime": st.st_mtime_ns}
    if st.st_size <= HASH_LIMIT:
        sig["sha1"] = _sha1(path)
    return sig


def matches(path: str, sig: dict) -> bool:
    """Is the file at path still the one recorded? A matching hash wins
    over a changed time (a copy back keeps the bytes, not the time)."""
    try:
        st = os.stat(path)
    except OSError:
        return False
    if st.st_size != sig.get("size"):
        return False
    if st.st_mtime_ns == sig.get("mtime"):
        return True
    if "sha1" in sig:
        try:
            return _sha1(path) == sig["sha1"]
        except OSError:
            return False
    return False


def status(root: str, files: dict) -> dict:
    """{"missing": [...], "changed": [...]} for a recorded setup."""
    missing, changed = [], []
    for rel, sig in (files or {}).items():
        p = os.path.join(root, *rel.split("/"))
        if not os.path.isfile(p):
            missing.append(rel)
        elif not matches(p, sig):
            changed.append(rel)
    return {"missing": sorted(missing), "changed": sorted(changed)}


def hub_candidates(folders: list) -> list:
    """MRSURVIV0R's VR HUB programs in the given folders (and one level
    down, for an extracted release zip), newest first."""
    found = []
    for base in folders:
        if not base or not os.path.isdir(base):
            continue
        try:
            entries = list(os.scandir(base))
        except OSError:
            continue
        for e in entries:
            cands = [e] if e.is_file() else []
            if e.is_dir() and "vr" in e.name.lower() and "hub" in e.name.lower():
                try:
                    cands = [x for x in os.scandir(e.path) if x.is_file()]
                except OSError:
                    cands = []
            for c in cands:
                low = c.name.lower()
                if low.endswith(".exe") and "vr" in low and "hub" in low and "surviv" in low.replace("0", "o"):
                    try:
                        found.append((c.stat().st_mtime, c.path))
                    except OSError:
                        pass
    return [p for _t, p in sorted(found, reverse=True)]
