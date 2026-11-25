"""Is the installed plugin the build it says it is?

Decky's installer (backend/decky_loader/browser.py, v3.3.1) replaces a plugin
by rmtree-ing its folder and extracting the new zip over whatever is left. On
Windows either step stops at the first file another process still holds:
rmtree's error is caught and logged as "was not uninstalled", extraction's is
not caught at all, and nothing tells the user. What remains is half one build
and half the other, and it fails to start in ways that say nothing about why.

So every release zip carries forge-manifest.json, written by
tools/make_release.sh and stored FIRST in the zip, so a copy that stopped
part-way still has the list of what should be there. At backend start the
sizes are compared at once (a stat per file) and the hashes on a thread, and
the frontend asks for the verdict.

Standard library only, and only modules Decky's frozen Windows Python has
(tests/decky_frozen_stdlib.txt): this has to work in the very case where the
rest of the plugin cannot import. Nothing here may import another py_module.
"""

import hashlib
import importlib
import json
import os
import sys
import threading
import types

MANIFEST = "forge-manifest.json"
FORMAT = 1
# Never part of a build: written at runtime, or by the tools that make one.
_SKIP_DIRS = {"__pycache__"}
_CHUNK = 1 << 20


def _rel(path: str) -> str:
    return path.replace(os.sep, "/")


def build_manifest(root: str, version: str) -> dict:
    """Path, size and SHA-256 of every file under root, the manifest excluded."""
    files = []
    for here, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS)
        for name in sorted(names):
            full = os.path.join(here, name)
            rel = _rel(os.path.relpath(full, root))
            if rel == MANIFEST:
                continue
            files.append({"path": rel, "size": os.path.getsize(full),
                          "sha256": _sha256(full)})
    return {"format": FORMAT, "version": version, "files": files}


def _sha256(path: str, cancel=None) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("hash check stopped")
            block = f.read(_CHUNK)
            if not block:
                return h.hexdigest()
            h.update(block)


def load_manifest(root: str):
    """The manifest as a dict, None when there is none, or raises ValueError
    for one that is there but unreadable (itself a sign of a broken copy)."""
    path = os.path.join(root, MANIFEST)
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{MANIFEST} cannot be read: {exc}") from None
    if (not isinstance(data, dict) or data.get("format") != FORMAT
            or not isinstance(data.get("files"), list)):
        raise ValueError(f"{MANIFEST} is not a format-{FORMAT} manifest")
    return data


def _entries(manifest: dict):
    for e in manifest.get("files") or []:
        if not isinstance(e, dict):
            continue
        path = str(e.get("path") or "")
        # A path that climbs out of the folder is not one of ours to stat.
        parts = path.split("/")
        if not path or path.startswith("/") or ".." in parts or "\\" in path or ":" in path:
            continue
        yield path, e.get("size"), str(e.get("sha256") or "")


def check_sizes(root: str, manifest: dict) -> list:
    """Problems found by stat alone: missing files and wrong sizes."""
    problems = []
    for path, size, _ in _entries(manifest):
        try:
            have = os.path.getsize(os.path.join(root, *path.split("/")))
        except OSError:
            problems.append(f"missing: {path}")
            continue
        if have != size:
            problems.append(f"wrong size: {path} ({have} bytes, expected {size})")
    return problems


def check_hashes(root: str, manifest: dict, cancel=None) -> list:
    problems = []
    for path, _, want in _entries(manifest):
        try:
            got = _sha256(os.path.join(root, *path.split("/")), cancel)
        except InterruptedError:
            raise
        except OSError as exc:
            problems.append(f"unreadable: {path} ({exc.strerror or exc})")
            continue
        if got != want:
            problems.append(f"changed: {path}")
    return problems


class Checker:
    """One backend start's verdict on its own install.

    status: "checking" while the hashes run, then "ok" or "broken";
    "no_manifest" for a build that has none (a dev deploy, or anything
    before anygame.67), which is not reported as a problem.
    """

    def __init__(self, root: str):
        self.root = root
        self.status = "checking"
        self.version = ""
        self.problems: list = []
        self.import_failures: dict = {}
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread = None

    def start(self, hash_in_thread: bool = True) -> "Checker":
        try:
            manifest = load_manifest(self.root)
        except ValueError as exc:
            self._finish("broken", [str(exc)])
            return self
        if manifest is None:
            self._finish("no_manifest", [])
            return self
        self.version = str(manifest.get("version") or "")
        problems = check_sizes(self.root, manifest)
        if problems:
            # Already decided: no need to read every byte to say so.
            self._finish("broken", problems)
            return self
        if not hash_in_thread:
            self._hash(manifest)
            return self
        self._thread = threading.Thread(target=self._hash, args=(manifest,),
                                        name="forge-integrity", daemon=True)
        self._thread.start()
        return self

    def _hash(self, manifest: dict) -> None:
        try:
            problems = check_hashes(self.root, manifest, self._cancel)
        except InterruptedError:
            return  # stopped for an update; the verdict no longer matters
        except Exception as exc:  # noqa: BLE001 - a verdict, never a crash
            problems = [f"hash check failed: {exc}"]
        self._finish("broken" if problems else "ok", problems)

    def _finish(self, status: str, problems: list) -> None:
        with self._lock:
            self.status, self.problems = status, list(problems)

    def note_import_failure(self, name: str, exc: BaseException) -> None:
        with self._lock:
            self.import_failures[name] = f"{type(exc).__name__}: {exc}"[:300]

    def stop(self, timeout: float = 5.0) -> None:
        """Stop hashing and let go of the file it has open. Called before an
        update hands the folder to Decky."""
        self._cancel.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "status": self.status,
                "version": self.version,
                "problems": self.problems[:8],
                "problem_count": len(self.problems),
                "import_failures": dict(self.import_failures),
            }


class _Unavailable(types.ModuleType):
    """Stands in for a py_module that failed to import, so main.py still
    loads, the backend still answers, and the user can be told to reinstall.
    Using it raises the original failure rather than an AttributeError."""

    def __init__(self, name: str, reason: str):
        super().__init__(name)
        self.__forge_unavailable__ = reason

    def __getattr__(self, attr):
        if attr.startswith("__") and attr.endswith("__"):
            raise AttributeError(attr)
        raise ImportError(f"{self.__name__} did not load ({self.__forge_unavailable__}); "
                          f"reinstall Forge")


_CHECKER = None


def begin(root: str) -> Checker:
    """Start this process's check once; later calls return the same one."""
    global _CHECKER
    if _CHECKER is None:
        _CHECKER = Checker(root).start()
    return _CHECKER


def current():
    return _CHECKER


def guarded_import(name: str):
    """import name, or a stand-in that records why it could not be."""
    try:
        return importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001 - SyntaxError from a truncated file too
        sys.modules.pop(name, None)
        if _CHECKER is not None:
            _CHECKER.note_import_failure(name, exc)
        return _Unavailable(name, f"{type(exc).__name__}: {exc}")
