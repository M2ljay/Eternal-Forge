"""Forge for ROM games from The Collector (eternal-romm): pure rules.

The Collector owns everything on the emulator's side: which emulator a ROM
launches with, where its mod folder is, the preview, the install, backups and
removal. Forge finds and downloads mods (GameBanana, Nexus Mods), puts the
archive into the Downloads folder The Collector lists, and keeps its own
record of what it installed so updates and the game page's card work.

Nothing here does I/O except the small record store at the end, which takes
its path from the caller. main.py holds the glue (``forge_rom_*``).
"""
import json
import os
import re
import threading
import time
import unicodedata

# ---- Platforms ------------------------------------------------------------
# RomM platform slugs (what The Collector passes as platformSlug) to the name
# GameBanana and Nexus Mods know the system by, plus the short forms a
# GameBanana game name sometimes carries ("Sonic Adventure DX (GC)").
# GameBanana lists games per title; its name search does not filter by
# platform, so the platform is used to rank and break ties, never to drop a
# candidate the user might still want.

PLATFORMS = {
    "ngc": ("GameCube", ("gamecube", "gc", "gcn", "ngc")),
    "gc": ("GameCube", ("gamecube", "gc", "gcn", "ngc")),
    "gamecube": ("GameCube", ("gamecube", "gc", "gcn", "ngc")),
    "wii": ("Wii", ("wii",)),
    "wiiu": ("Wii U", ("wii u", "wiiu")),
    "switch": ("Switch", ("switch", "nintendo switch", "nx")),
    "3ds": ("3DS", ("3ds", "nintendo 3ds")),
    "n3ds": ("3DS", ("3ds", "new 3ds", "nintendo 3ds")),
    "nds": ("DS", ("nds", "ds", "nintendo ds")),
    "n64": ("Nintendo 64", ("n64", "nintendo 64")),
    "snes": ("SNES", ("snes", "super nintendo", "sfc", "super famicom")),
    "sfam": ("SNES", ("snes", "super famicom", "sfc")),
    "nes": ("NES", ("nes", "famicom")),
    "famicom": ("NES", ("nes", "famicom")),
    "gba": ("Game Boy Advance", ("gba", "game boy advance")),
    "gbc": ("Game Boy Color", ("gbc", "game boy color")),
    "gb": ("Game Boy", ("gb", "game boy")),
    "psx": ("PlayStation", ("ps1", "psx", "playstation")),
    "ps1": ("PlayStation", ("ps1", "psx", "playstation")),
    "ps2": ("PlayStation 2", ("ps2", "playstation 2")),
    "ps3": ("PlayStation 3", ("ps3", "playstation 3")),
    "psp": ("PSP", ("psp", "playstation portable")),
    "psvita": ("PS Vita", ("vita", "ps vita", "psvita")),
    "genesis-slash-megadrive": ("Genesis", ("genesis", "mega drive", "megadrive", "md")),
    "megadrive": ("Genesis", ("genesis", "mega drive", "megadrive")),
    "genesis": ("Genesis", ("genesis", "mega drive", "megadrive")),
    "dc": ("Dreamcast", ("dreamcast", "dc")),
    "dreamcast": ("Dreamcast", ("dreamcast", "dc")),
    "saturn": ("Saturn", ("saturn",)),
    "xbox": ("Xbox", ("xbox", "og xbox")),
    "xbox360": ("Xbox 360", ("xbox 360", "x360", "xbox360")),
}

# Slugs RomM uses that GameBanana has no section for (or too little to match
# against): name matching still runs, without a platform hint. Documented in
# docs/gamebanana.md.
UNMAPPED_EXAMPLES = ("arcade", "neogeoaes", "atari2600", "pce", "msx", "wonderswan", "ngp", "3do", "jaguar", "lynx")


def platform_info(slug: str) -> dict:
    """{slug, name, tokens, mapped} for a RomM platform slug."""
    key = (slug or "").strip().lower()
    hit = PLATFORMS.get(key)
    if not hit:
        return {"slug": key, "name": "", "tokens": [], "mapped": False}
    return {"slug": key, "name": hit[0], "tokens": list(hit[1]), "mapped": True}


# ---- Matching a ROM to a GameBanana or Nexus game -------------------------

_REGION = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


def clean_rom_name(name: str) -> str:
    """A ROM's title without region/revision tags: "Super Mario Sunshine
    (USA) (Rev 1)" -> "Super Mario Sunshine"."""
    out = _REGION.sub("", name or "").strip()
    return re.sub(r"\s{2,}", " ", out) or (name or "").strip()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _platform_tags(name: str) -> list:
    """Bracketed tags at the end of a candidate's name, normalised."""
    return [norm(t) for t in re.findall(r"[\(\[]([^\)\]]+)[\)\]]", name or "")]


def search_queries(rom_name: str, platform_slug: str) -> list:
    """What to ask GameBanana's name search, in order: the clean title, then
    the title with the platform's name (only for a mapped platform)."""
    base = clean_rom_name(rom_name)
    out = [base] if base else []
    info = platform_info(platform_slug)
    if base and info["mapped"]:
        out.append(f"{base} {info['name']}")
    return out


def rank_candidates(rom_name: str, platform_slug: str, candidates: list) -> list:
    """Candidates ({id, name, ...}) best first, each with a "score" and
    "platform_match". Higher is better:

    - 100: same title (tags aside) and a platform tag that names this system;
    - 90: same title, no platform tag;
    - 40: same title but a tag naming ANOTHER system (kept: the user decides);
    - 20 + overlap: titles that share words.
    Duplicates by id are dropped."""
    want = norm(clean_rom_name(rom_name))
    info = platform_info(platform_slug)
    mine = {norm(t) for t in info["tokens"]}
    others = {norm(t) for (n, toks) in PLATFORMS.values() if n != info["name"] for t in toks} - mine
    seen = set()
    ranked = []
    for c in candidates or []:
        cid = c.get("id")
        if not cid or cid in seen:
            continue
        seen.add(cid)
        name = c.get("name") or ""
        title = norm(clean_rom_name(name))
        tags = _platform_tags(name)
        trailing = norm(name)
        has_mine = any(t in mine for t in tags) or any(trailing.endswith(" " + t) for t in mine if t)
        has_other = any(t in others for t in tags)
        stripped = title
        for t in sorted(mine, key=len, reverse=True):
            if t and stripped.endswith(" " + t):
                stripped = stripped[: -len(t) - 1].strip()
        if want and (title == want or stripped == want):
            score = 100 if has_mine else (40 if has_other else 90)
        else:
            a, b = set(want.split()), set(title.split())
            overlap = len(a & b) / max(1, len(a | b))
            score = 20 + int(overlap * 15) + (5 if has_mine else 0)
        ranked.append(dict(c, score=score, platform_match=bool(has_mine)))
    ranked.sort(key=lambda c: (-c["score"], c.get("name") or ""))
    return ranked


def auto_pick(ranked: list):
    """The candidate to link by itself, or None (then the user picks):
    exactly one best candidate scoring 90 or more."""
    top = [c for c in ranked if c.get("score", 0) >= 90]
    if not top:
        return None
    best = top[0]["score"]
    firsts = [c for c in top if c["score"] == best]
    return firsts[0] if len(firsts) == 1 else None


# ---- Staging into Downloads -------------------------------------------------
# The Collector installs only from the top of %USERPROFILE%\Downloads, by entry
# name: `.zip` archives, folders, and `.ips/.bps/.ups` soft patches (or a .zip
# holding exactly one). Forge saves its download there under the archive's own
# file name (the contract with The Collector, 0.33.0-win.28), with " (2)" and
# so on when the name is taken, and unpacks any other archive kind into a
# folder named after the archive. No Forge subfolder: a folder in Downloads is
# itself an installable source.

PATCH_EXTS = (".ips", ".bps", ".ups")
# Cheat files (The Collector's cheatFile targets): copied as is, renamed by
# The Collector to the file the emulator reads.
CHEAT_EXTS = (".txt", ".pnach", ".cht")
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def stage_kind(file_name: str) -> str:
    """"zip", "patch", "cheat" or "extract" (any other archive: unpacked to
    a folder)."""
    ext = os.path.splitext(file_name or "")[1].lower()
    if ext == ".zip":
        return "zip"
    if ext in PATCH_EXTS:
        return "patch"
    if ext in CHEAT_EXTS:
        return "cheat"
    return "extract"


def safe_entry_base(name: str, limit: int = 120) -> str:
    """A Windows-safe file name stem."""
    s = unicodedata.normalize("NFKC", name or "")
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    if not s:
        s = "mod"
    s = s[:limit].rstrip(". ")
    if s.split(".")[0].lower() in _RESERVED:
        s = "_" + s
    return s


def stage_entry_name(mod_name: str, file_name: str, taken) -> str:
    """The Downloads entry name for a staged download: the archive's own file
    name ("pack.zip", "fix.ips"), or for an archive Forge unpacks the folder
    named after it ("pack"); "pack (2).zip" when the name is taken (names in
    `taken`, compared case-insensitively). mod_name names it only when the
    file has no usable name."""
    kind = stage_kind(file_name)
    stem, ext = os.path.splitext(os.path.basename((file_name or "").replace("\\", "/")))
    base = safe_entry_base(stem or mod_name)
    ext = ext.lower() if kind in ("zip", "patch", "cheat") else ""
    lower = {str(t).lower() for t in taken or ()}
    n = 1
    while True:
        cand = f"{base}{'' if n == 1 else f' ({n})'}{ext}"
        if cand.lower() not in lower:
            return cand
        n += 1


def is_entry_name(name: str) -> bool:
    """A single Downloads entry name: no separator, no drive, not dot-only."""
    return bool(name) and name not in (".", "..") and not re.search(r'[\\/:\x00]', name) and name == name.strip()


def same_folder(a: str, b: str) -> bool:
    """Two Windows paths name the same folder (case and slashes aside)."""
    def n(p):
        parts = [x for x in (p or "").replace("\\", "/").lower().split("/") if x and x != "."]
        return "/".join(parts)
    return bool(a and b) and n(a) == n(b)


# ---- Records ------------------------------------------------------------------
# One list per ROM app id: what Forge installed through The Collector.

SOURCES = ("gamebanana", "nexus", "local", "ctrpf", "libretro", "gamehacking")
# Sources whose files have no numeric mod id: a record is named by its file.
FILE_SOURCES = ("local", "ctrpf", "libretro", "gamehacking")


def make_record(raw: dict, now: float) -> dict:
    """A clean record from what the frontend sends after an install."""
    source = str(raw.get("source") or "")
    if source not in SOURCES:
        raise ValueError("unknown source")
    entries = [str(e) for e in (raw.get("entries") or []) if is_entry_name(str(e))]
    rec = {
        "id": f"{source}:{int(raw.get('mod_id') or 0)}:{int(raw.get('file_id') or 0)}:{str(raw.get('target_id') or '')}",
        "source": source,
        "mod_id": int(raw.get("mod_id") or 0),
        "file_id": int(raw.get("file_id") or 0),
        "file_name": str(raw.get("file_name") or "")[:200],
        "file_date": int(raw.get("file_date") or 0),
        "name": str(raw.get("name") or raw.get("file_name") or "mod")[:200],
        "version": str(raw.get("version") or "")[:60],
        "domain": str(raw.get("domain") or "")[:80],
        "target_id": str(raw.get("target_id") or "")[:120],
        "target_label": str(raw.get("target_label") or "")[:120],
        "entries": entries,
        "rom_id": int(raw.get("rom_id") or 0),
        "kind": str(raw.get("kind") or "files")[:20],
        "installed_at": int(now),
    }
    if source in FILE_SOURCES:
        rec["id"] = f"{source}:{rec['file_name']}:{rec['target_id']}"
    return rec


def upsert(records: list, rec: dict) -> list:
    """The list with `rec` in place of any record of the same mod and target
    (an update replaces the old file's record)."""
    def same(r):
        # A cheat-file target holds ONE file: a new one replaces any record there.
        if rec.get("kind") == "cheatFile" and r.get("target_id") == rec["target_id"]:
            return True
        return (r.get("source") == rec["source"] and r.get("target_id") == rec["target_id"]
                and (r.get("mod_id") == rec["mod_id"] if rec["source"] not in FILE_SOURCES else r.get("id") == rec["id"]))
    return [r for r in records if not same(r)] + [rec]


def new_entries(before: list, after: list) -> list:
    """Entry names in a target after an install that were not there before
    (what the install added; replaced files keep their names)."""
    seen = {str(n).lower() for n in before or []}
    return [n for n in after or [] if str(n).lower() not in seen]


def nexus_update_for(record: dict, files: list):
    """The newer Nexus file for an installed record, or None. `files` are
    get_mod_files entries ({file_id, uploaded_timestamp, category_name,
    version, ...}). A newer MAIN file uploaded after the installed one
    counts; old and archived files never do."""
    installed = int(record.get("file_id") or 0)
    base = int(record.get("file_date") or 0)
    for f in files or []:
        if int(f.get("file_id") or 0) == installed:
            base = max(base, int(f.get("uploaded_timestamp") or 0))
    best = None
    for f in files or []:
        if int(f.get("file_id") or 0) == installed:
            continue
        if str(f.get("category_name") or "").upper() not in ("MAIN", "UPDATE"):
            continue
        ts = int(f.get("uploaded_timestamp") or 0)
        if base and ts <= base + 120:
            continue
        if best is None or ts > int(best.get("uploaded_timestamp") or 0):
            best = f
    return best


class RecordStore:
    """{app_id: [record]} in one JSON file, written atomically."""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()

    def _read(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, self.path)

    def all(self) -> dict:
        with self.lock:
            return self._read()

    def records(self, app_id: int) -> list:
        with self.lock:
            got = (self._read().get("games") or {}).get(str(int(app_id))) or []
            return [r for r in got if isinstance(r, dict)]

    def put(self, app_id: int, rec: dict) -> list:
        with self.lock:
            data = self._read()
            games = data.setdefault("games", {})
            games[str(int(app_id))] = upsert(
                [r for r in games.get(str(int(app_id))) or [] if isinstance(r, dict)], rec)
            self._write(data)
            return games[str(int(app_id))]

    def forget(self, app_id: int, rec_id: str) -> list:
        with self.lock:
            data = self._read()
            games = data.setdefault("games", {})
            left = [r for r in games.get(str(int(app_id))) or [] if isinstance(r, dict) and r.get("id") != rec_id]
            games[str(int(app_id))] = left
            self._write(data)
            return left

    def link(self, app_id: int, kind: str, value=None, clear: bool = False):
        """The ROM's Nexus link ({domain, name}); set it with value, forget it
        with clear."""
        with self.lock:
            data = self._read()
            links = data.setdefault("links", {}).setdefault(str(int(app_id)), {})
            if clear:
                links.pop(kind, None)
                self._write(data)
                return None
            if value is not None:
                links[kind] = value
                self._write(data)
            return links.get(kind)

    def note_staged(self, name: str, add: bool = True) -> list:
        """Downloads entries Forge created and may remove again."""
        with self.lock:
            data = self._read()
            staged = [s for s in data.get("staged") or [] if isinstance(s, str)]
            if add and name not in staged:
                staged.append(name)
            if not add:
                staged = [s for s in staged if s != name]
            data["staged"] = staged[-200:]
            self._write(data)
            return staged

    def staged(self) -> list:
        with self.lock:
            return [s for s in self._read().get("staged") or [] if isinstance(s, str)]


def now() -> float:
    return time.time()
