"""Cheat files for ROM games from The Collector: where Forge finds them.

The Collector (win.29) has a `cheatFile` target per emulator that writes the
one file the emulator reads (Azahar `cheats/<TitleID>.txt`, PCSX2
`cheats/<SERIAL>_<CRC>.pnach`, RetroArch `cheats/<core>/<stem>.cht`), renaming
whatever Downloads entry it is given. Forge's part is finding the right file
and saving it at the top of Downloads under its own name:

- Azahar (3DS): GitHub JourneyOver/CTRPF-AR-CHEAT-CODES, laid out as
  ``Cheats/<Game> (<REGION>)/<TitleID>.txt``. Matched by Title ID (the
  16-hex-digit id The Collector read from the game file); the Title ID is
  per region, so a match is the right region by construction. Read from the
  repository's zip on codeload.github.com (about 1 MB, cached a week): the
  folder names are not derivable from the Title ID, and api.github.com is
  off limits (60 calls an hour per IP, shared by every device behind it).
- RetroArch: libretro's libretro-database ``cht/<System>/<No-Intro name>.cht``
  (CC BY-SA 4.0), 267 MB in all, so it is not listed: Forge asks
  raw.githubusercontent.com for a handful of likely names (the ROM file's
  own stem, which The Collector names the cheat target after, then the
  title with the usual No-Intro regions) and offers the ones that exist.
- PCSX2: GameHacking.org publishes no API or bulk download format and no
  terms that permit automated access, so Forge links out and installs the
  user's own .pnach from Downloads.

Pure rules only; main.py does the HTTP (``forge_rom_cheat_*``).
"""
import posixpath
import re
import urllib.parse

import rom_mods

CTRPF = {"owner": "JourneyOver", "repo": "CTRPF-AR-CHEAT-CODES", "branch": "master"}
LIBRETRO = {"owner": "libretro", "repo": "libretro-database", "branch": "master"}

# RomM platform slug -> libretro-database cht/ folder.
LIBRETRO_SYSTEMS = {
    "nes": "Nintendo - Nintendo Entertainment System",
    "famicom": "Nintendo - Nintendo Entertainment System",
    "fds": "Nintendo - Family Computer Disk System",
    "snes": "Nintendo - Super Nintendo Entertainment System",
    "sfam": "Nintendo - Super Nintendo Entertainment System",
    "n64": "Nintendo - Nintendo 64",
    "gb": "Nintendo - Game Boy",
    "gbc": "Nintendo - Game Boy Color",
    "gba": "Nintendo - Game Boy Advance",
    "nds": "Nintendo - Nintendo DS",
    "virtualboy": "Nintendo - Virtual Boy",
    "genesis-slash-megadrive": "Sega - Mega Drive - Genesis",
    "megadrive": "Sega - Mega Drive - Genesis",
    "genesis": "Sega - Mega Drive - Genesis",
    "sms": "Sega - Master System - Mark III",
    "gamegear": "Sega - Game Gear",
    "sega32": "Sega - 32X",
    "segacd": "Sega - Mega-CD - Sega CD",
    "saturn": "Sega - Saturn",
    "dc": "Sega - Dreamcast",
    "dreamcast": "Sega - Dreamcast",
    "psx": "Sony - PlayStation",
    "ps1": "Sony - PlayStation",
    "psp": "Sony - PlayStation Portable",
    "tg16": "NEC - PC Engine - TurboGrafx 16",
    "pce": "NEC - PC Engine - TurboGrafx 16",
    "ngp": "SNK - Neo Geo Pocket",
    "ngpc": "SNK - Neo Geo Pocket Color",
    "wonderswan": "Bandai - WonderSwan",
    "wonderswan-color": "Bandai - WonderSwan Color",
    "atari2600": "Atari - 2600",
    "atari7800": "Atari - 7800",
    "lynx": "Atari - Lynx",
    "jaguar": "Atari - Jaguar",
    "arcade": "FBNeo - Arcade Games",
}

MAX_CHEAT_BYTES = 2 * 1024 * 1024
_TITLE_ID = re.compile(r"^[0-9A-Fa-f]{16}$")


def is_title_id(value: str) -> bool:
    return bool(_TITLE_ID.match(value or ""))


CTRPF_ZIP_URL = "https://codeload.github.com/JourneyOver/CTRPF-AR-CHEAT-CODES/zip/refs/heads/master"
MAX_CTRPF_ZIP = 32 * 1024 * 1024


def zip_paths(names: list) -> list:
    """Repository paths from a codeload zip's member names (the first folder,
    "<repo>-<branch>/", dropped; folders left out)."""
    out = []
    for n in names or []:
        parts = str(n).split("/", 1)
        if len(parts) == 2 and parts[1] and not parts[1].endswith("/"):
            out.append(parts[1])
    return out


def zip_member(names: list, path: str) -> str:
    """The zip member name for a repository path, or ''."""
    for n in names or []:
        parts = str(n).split("/", 1)
        if len(parts) == 2 and parts[1] == path:
            return str(n)
    return ""


def region_of(name: str) -> str:
    """The last bracketed tag that names a region-ish word: "Sonic (EUR)" -> "EUR"."""
    tags = re.findall(r"\(([^)]*)\)", name or "")
    return tags[0] if tags else ""


def ctrpf_matches(paths: list, title_id: str) -> list:
    """[{path, label, region}] for CTRPF cheat files named by this Title ID."""
    if not is_title_id(title_id):
        return []
    want = title_id.lower() + ".txt"
    out = []
    for p in paths:
        parts = p.split("/")
        if len(parts) == 3 and parts[0] == "Cheats" and parts[2].lower() == want:
            out.append({"path": p, "label": parts[1], "region": region_of(parts[1])})
    return out


_REGIONS = ("USA", "World", "USA, Europe", "Europe", "Japan", "USA, Japan", "Japan, USA")


def libretro_guesses(file_stem: str, rom_name: str, limit: int = 8) -> list:
    """Likely libretro cheat file names (without folder), best first: the ROM
    file's own stem (No-Intro dumps carry the exact name), then the clean
    title with the common regions."""
    out = []

    def add(n):
        n = (n or "").strip()
        if n and not re.search(r'[\\/:*?"<>|\x00]', n) and f"{n}.cht" not in out:
            out.append(f"{n}.cht")
    add(re.sub(r"\.cht$", "", file_stem or "", flags=re.I))
    title = rom_mods.clean_rom_name(rom_name)
    for r in _REGIONS:
        add(f"{title} ({r})")
    return out[:limit]


def libretro_folder(platform_slug: str) -> str:
    return LIBRETRO_SYSTEMS.get((platform_slug or "").strip().lower(), "")


def valid_path(source: str, path: str) -> bool:
    """A repository path Forge may fetch for this source (no traversal, the
    expected folder and extension)."""
    if not path or "\\" in path or "\x00" in path or path.startswith("/"):
        return False
    if posixpath.normpath(path) != path or ".." in path.split("/"):
        return False
    parts = path.split("/")
    if source == "ctrpf":
        return len(parts) == 3 and parts[0] == "Cheats" and is_title_id(parts[2][:-4]) and parts[2].lower().endswith(".txt")
    if source == "libretro":
        return (len(parts) == 3 and parts[0] == "cht" and parts[1] in LIBRETRO_SYSTEMS.values()
                and parts[2].lower().endswith(".cht"))
    return False


def repo_of(source: str) -> dict:
    return CTRPF if source == "ctrpf" else LIBRETRO


def raw_url(source: str, path: str) -> str:
    r = repo_of(source)
    quoted = "/".join(urllib.parse.quote(p) for p in path.split("/"))
    return f"https://raw.githubusercontent.com/{r['owner']}/{r['repo']}/{r['branch']}/{quoted}"


def looks_like_text_cheats(data: bytes) -> bool:
    """A cheat file is text, not a web page or a binary."""
    head = (data or b"")[:512].lstrip().lower()
    if head.startswith(b"<!doctype") or head.startswith(b"<html"):
        return False
    return b"\x00" not in (data or b"")[:4096]
