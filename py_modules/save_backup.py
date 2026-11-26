"""Forge: save backups through Ludusavi before risky mod changes.

Ludusavi (https://github.com/mtkennerly/ludusavi, MIT) is an optional,
separately installed tool (`winget install -e --id mtkennerly.ludusavi`).
Forge never installs it and never changes its configuration: backups go to
the folder Ludusavi itself is configured with, cloud sync follows its own
setting.

Everything here talks to the `ludusavi` command line in its `--api` mode
(JSON on stdout, docs/help/command-line.md and docs/schema/general-output.yaml
in Ludusavi's repository, checked against v0.31.0):

- `ludusavi --try-manifest-update find --api --steam-id <app id>`, then by
  exact title, then `--normalized`: Ludusavi's own name for the game.
  `{"games": {"<title>": {...}}}`, exit code 1 when nothing matches.
- `ludusavi --try-manifest-update backup --force --api <title>`:
  `{"errors": {"someGamesFailed", "unknownGames", "cloudSyncFailed",
  "cloudConflict"}, "overall": {...}, "games": {"<title>": {"decision":
  "Processed" | "Ignored" | "Cancelled", "files": {path: {"bytes",
  "failed", "ignored", ...}}, "registry": {...}}}}`.
- `ludusavi backups --api <title>`: `{"games": {"<title>": {"backupPath",
  "backups": [{"name", "when", "os", "comment", "locked"}]}}}`; `name` is
  the id `restore --backup` takes.
- `ludusavi --try-manifest-update restore --force --api --backup <id> <title>`.

`--try-manifest-update` keeps an offline PC working: Ludusavi otherwise
fails when its periodic manifest download fails.

No Decky and no settings file here; main.py owns the state, the callables
and the wrappers around the install calls. Standard library only: Decky's
frozen Windows Python loads this at import time.
"""

from __future__ import annotations

import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

WINGET_ID = "mtkennerly.ludusavi"
INSTALL_HINT = "Install Ludusavi to back up saves before mod changes"
INSTALL_COMMAND = f"winget install -e --id {WINGET_ID}"

# Seconds. A backup that runs past its time box is stopped and the mod
# change goes ahead: a save backup is a safety net, never a gate.
BACKUP_TIMEOUT = 60
LOOKUP_TIMEOUT = 30
LIST_TIMEOUT = 30
RESTORE_TIMEOUT = 120

DEFAULT_SKIP_MINUTES = 30
MAX_SKIP_MINUTES = 24 * 60
# Ludusavi's title for a Steam game rarely changes; a game it does not know
# is asked again a day later (its manifest updates itself).
TITLE_TTL = 7 * 86400
MISS_TTL = 86400

# Windows: ludusavi.exe is a console program, and the loader has no
# console, so without this each run flashes a window over the game.
NO_WINDOW = {"creationflags": 0x08000000} if sys.platform == "win32" else {}

# Steam gives non-Steam shortcuts app ids with the top bit set; Ludusavi's
# manifest only knows real Steam ids.
_SHORTCUT_BIT = 0x80000000


# ---- Finding ludusavi ------------------------------------------------------------

def candidate_paths(env: dict, platform: str = sys.platform) -> list:
    """Where winget and Scoop put ludusavi.exe, for a loader whose PATH
    predates the install (winget adds its Links folder to the user's PATH,
    which a running process does not see)."""
    if not platform.startswith("win"):
        home = env.get("HOME") or ""
        return [os.path.join(home, ".local", "bin", "ludusavi")] if home else []
    exe = "ludusavi.exe"
    out = []
    local = env.get("LOCALAPPDATA") or ""
    program_files = env.get("ProgramFiles") or ""
    for base in (local and os.path.join(local, "Microsoft", "WinGet"),
                 program_files and os.path.join(program_files, "WinGet")):
        if not base:
            continue
        out.append(os.path.join(base, "Links", exe))
        # Portable packages unpack to Packages\<id>_<source>\ (zip root).
        pattern = os.path.join(glob.escape(os.path.join(base, "Packages")), WINGET_ID + "_*")
        for pkg in sorted(glob.glob(pattern)):
            out.append(os.path.join(pkg, exe))
            out.extend(sorted(glob.glob(os.path.join(glob.escape(pkg), "*", exe))))
    profile = env.get("USERPROFILE") or ""
    scoop_roots = [env.get("SCOOP") or (profile and os.path.join(profile, "scoop")),
                   env.get("SCOOP_GLOBAL") or (env.get("ProgramData") and
                                               os.path.join(env["ProgramData"], "scoop"))]
    for root in scoop_roots:
        if root:
            out.append(os.path.join(root, "apps", "ludusavi", "current", exe))
            out.append(os.path.join(root, "shims", exe))
    return out


def find_ludusavi(env: dict = None, which=shutil.which, isfile=os.path.isfile,
                  platform: str = sys.platform) -> str:
    """The ludusavi executable: PATH first, then the usual winget and Scoop
    locations. "" when it is not installed."""
    env = os.environ if env is None else env
    for name in ("ludusavi", "ludusavi.exe"):
        try:
            hit = which(name, path=env.get("PATH"))
        except (OSError, ValueError):
            hit = None
        if hit:
            return hit
    for path in candidate_paths(env, platform):
        try:
            if isfile(path):
                return path
        except OSError:
            continue
    return ""


# ---- Running it --------------------------------------------------------------------

def run_ludusavi(argv: list, timeout: float, env: dict = None) -> dict:
    """Run one ludusavi command. Never raises: {"rc", "out", "err",
    "timed_out"}; rc is -1 when it could not start or was stopped."""
    try:
        proc = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=timeout, env=env, **NO_WINDOW)
    except subprocess.TimeoutExpired:
        # subprocess.run has already killed it.
        return {"rc": -1, "out": "", "err": "", "timed_out": True}
    except (OSError, ValueError) as e:
        return {"rc": -1, "out": "", "err": str(e), "timed_out": False}
    return {"rc": proc.returncode, "out": _text(proc.stdout), "err": _text(proc.stderr),
            "timed_out": False}


def deadline_runner(runner, seconds: float, clock):
    """A runner whose commands together stay within `seconds`: the title
    lookups and the backup share one time box."""
    end = clock() + seconds

    def run(argv, timeout, env=None):
        left = end - clock()
        if left <= 0:
            return {"rc": -1, "out": "", "err": "", "timed_out": True}
        return runner(argv, min(timeout, left), env)
    return run


def _text(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    return raw.decode("utf-8", errors="replace")


def parse_api(out: str):
    """Ludusavi's --api JSON, or None. Its docs say stdout can be blank on
    some errors, so blank is not a failure to parse."""
    out = (out or "").strip()
    if not out:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        # A warning printed before the JSON: take from the first brace.
        start = out.find("{")
        if start <= 0:
            return None
        try:
            data = json.loads(out[start:])
        except ValueError:
            return None
    return data if isinstance(data, dict) else None


def _first_line(text: str, limit: int = 200) -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return ""


def _base(exe: str) -> list:
    return [exe, "--try-manifest-update"]


# ---- Ludusavi's name for the game --------------------------------------------------

def _titles(result: dict) -> list:
    if result.get("rc") != 0:
        return []
    data = parse_api(result.get("out", "")) or {}
    games = data.get("games")
    return [t for t in games if isinstance(t, str) and t] if isinstance(games, dict) else []


def find_title(exe: str, app_id: int, name: str = "", runner=run_ludusavi, env: dict = None) -> str:
    """Ludusavi's title for a game: by Steam id, then the exact name, then
    the normalized name ("edition" and year suffixes, case). "" when it does
    not know the game, or a name matches more than one title."""
    tries = []
    try:
        app_id = int(app_id or 0)
    except (TypeError, ValueError):
        app_id = 0
    if 0 < app_id < _SHORTCUT_BIT:
        tries.append(["--steam-id", str(app_id)])
    name = (name or "").strip()
    if name:
        tries.append([name])
        tries.append(["--normalized", name])
    for extra in tries:
        titles = _titles(runner(_base(exe) + ["find", "--api"] + extra, LOOKUP_TIMEOUT, env))
        if len(titles) == 1:
            return titles[0]
    return ""


# ---- Backup, list, restore ---------------------------------------------------------

def _failure(result: dict, what: str, timeout: int) -> str:
    if result.get("timed_out"):
        return f"Ludusavi took longer than {timeout} seconds, so the {what} was stopped."
    detail = _first_line(result.get("err", "")) or _first_line(result.get("out", ""))
    return f"Ludusavi's {what} failed" + (f": {detail}" if detail else f" (exit code {result.get('rc')}).")


def _outcome(result: dict, title: str, what: str, timeout: int) -> dict:
    """Read a backup or restore result. ok also when Ludusavi found no save
    files for the game (nothing to lose) or only its cloud sync failed (the
    local copy is made)."""
    data = parse_api(result.get("out", ""))
    if result.get("timed_out") or data is None:
        return {"ok": False, "error": _failure(result, what, timeout)}
    errors = data.get("errors") if isinstance(data.get("errors"), dict) else {}
    if errors.get("unknownGames"):
        return {"ok": False, "unknown": True,
                "error": f"Ludusavi doesn't know \"{title}\" any more."}
    game = (data.get("games") or {}).get(title) if isinstance(data.get("games"), dict) else None
    files = game.get("files") if isinstance(game, dict) and isinstance(game.get("files"), dict) else {}
    failed = [p for p, f in files.items() if isinstance(f, dict) and f.get("failed")]
    if errors.get("someGamesFailed") or failed or result.get("rc") != 0:
        n = len(failed)
        return {"ok": False,
                "error": (f"Ludusavi couldn't {'back up' if what == 'backup' else 'restore'} "
                          f"{n} file{'' if n == 1 else 's'}." if n else _failure(result, what, timeout))}
    if isinstance(game, dict) and game.get("decision") not in (None, "Processed"):
        return {"ok": False, "error": f"Ludusavi skipped the game ({game.get('decision')}); "
                                      "it may be switched off in Ludusavi."}
    kept = [f for f in files.values() if isinstance(f, dict) and not f.get("ignored")]
    out = {"ok": True, "files": len(kept),
           "bytes": sum(int(f.get("bytes") or 0) for f in kept),
           "empty": not kept and not (game or {}).get("registry")}
    # Present (as {}) when the cloud step failed or found a conflict.
    if errors.get("cloudSyncFailed") is not None or errors.get("cloudConflict") is not None:
        out["note"] = "Saved locally; Ludusavi's cloud sync did not run."
    return out


def backup(exe: str, title: str, runner=run_ludusavi, env: dict = None, timeout: int = None) -> dict:
    timeout = timeout or BACKUP_TIMEOUT
    result = runner(_base(exe) + ["backup", "--force", "--api", title], timeout, env)
    return _outcome(result, title, "backup", timeout)


def restore(exe: str, title: str, backup_id: str, runner=run_ludusavi, env: dict = None,
            timeout: int = None) -> dict:
    timeout = timeout or RESTORE_TIMEOUT
    argv = _base(exe) + ["restore", "--force", "--api"]
    if backup_id:
        argv += ["--backup", backup_id]
    result = runner(argv + [title], timeout, env)
    return _outcome(result, title, "restore", timeout)


_WHEN = re.compile(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$")


def parse_when(when: str) -> int:
    """Seconds since the epoch from Ludusavi's RFC 3339 time (UTC, with up
    to nine fractional digits, which datetime.fromisoformat refuses on older
    Pythons). 0 when unreadable."""
    m = _WHEN.match(str(when or "").strip())
    if not m:
        return 0
    y, mo, d, h, mi, s, tz = m.groups()
    offset = 0
    if tz and tz != "Z":
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        offset = sign * (int(digits[:2]) * 3600 + int(digits[2:]) * 60)
    try:
        dt = datetime.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s),
                               tzinfo=datetime.timezone.utc)
    except ValueError:
        return 0
    return int(dt.timestamp()) - offset


def list_backups(exe: str, title: str, runner=run_ludusavi, env: dict = None) -> dict:
    """Ludusavi's backups of one game, newest first."""
    result = runner([exe, "backups", "--api", title], LIST_TIMEOUT, env)
    data = parse_api(result.get("out", ""))
    if result.get("timed_out") or data is None:
        if result.get("rc") == 0 and not result.get("timed_out"):
            return {"ok": True, "backups": [], "path": ""}
        return {"ok": False, "error": _failure(result, "backup list", LIST_TIMEOUT)}
    game = (data.get("games") or {}).get(title) if isinstance(data.get("games"), dict) else None
    if not isinstance(game, dict):
        # Ludusavi leaves a game with no backups out of the list.
        return {"ok": True, "backups": [], "path": ""}
    rows = []
    for b in game.get("backups") or []:
        if not isinstance(b, dict) or not isinstance(b.get("name"), str) or not b["name"]:
            continue
        rows.append({"id": b["name"], "when": str(b.get("when") or ""),
                     "at": parse_when(b.get("when")), "comment": str(b.get("comment") or ""),
                     "locked": bool(b.get("locked")), "os": str(b.get("os") or "")})
    rows.sort(key=lambda r: r["at"], reverse=True)
    return {"ok": True, "backups": rows, "path": str(game.get("backupPath") or "")}


# ---- When to run -----------------------------------------------------------------

def clamp_minutes(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SKIP_MINUTES
    return max(0, min(MAX_SKIP_MINUTES, n))


def should_skip(last_at: float, now: float, minutes: int) -> bool:
    """A backup for this game ran (worked or not) within the window: a
    collection of 300 mods is one backup, not 300, and a failing Ludusavi
    is not retried before every one of them."""
    try:
        last_at = float(last_at or 0)
    except (TypeError, ValueError):
        return False
    return bool(last_at) and minutes > 0 and 0 <= now - last_at < minutes * 60


def cached_title(entry: dict, now: float):
    """The remembered title ("" for a remembered miss), or None when it
    must be looked up again."""
    if not isinstance(entry, dict) or "title" not in entry:
        return None
    title = entry.get("title")
    age = now - float(entry.get("title_at") or 0)
    if not isinstance(title, str) or age < 0:
        return None
    return title if age < (TITLE_TTL if title else MISS_TTL) else None
