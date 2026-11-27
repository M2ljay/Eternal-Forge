"""Forge: OptiScaler per game, as a Forge "mod" on the game page.

OptiScaler (https://github.com/optiscaler/OptiScaler, GPL-3.0) swaps a
game's upscaler (DLSS / FSR 2-3 / XeSS inputs) for another one: FSR 4 on
RDNA 4, FSR 3.1, XeSS, or DLSS passed through. Windows loads it from the
game's folder as a proxy DLL (dxgi.dll, winmm.dll, version.dll), so no
launch option is involved.

Forge never ships OptiScaler: the official GitHub release is downloaded at
install time, checked against the SHA-256 digest GitHub publishes for the
asset (or pinned on first sight when there is none), unpacked, and copied
next to the game's exe. Nothing here is taken from OptiScaler's or Clarity's
code; it is written from OptiScaler's public documentation (the wiki's
Manual Installation page and the OptiScaler.ini shipped with each release).

Pure logic only - no Decky, no network, no settings file. main.py owns the
download, the file work, the state in forge.json and the Plugin methods.

OptiScaler hooks the game's graphics calls from inside its process. To an
anti-cheat that is DLL injection, so it is refused for every game Forge's
anti-cheat lock knows about - with no override, unlike ordinary mods - and
for online-competitive games.
"""

from __future__ import annotations

import os
import re

REPO = "optiscaler/OptiScaler"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
# Only assets of the official repository's releases are ever downloaded.
DOWNLOAD_PREFIX = f"https://github.com/{REPO}/releases/download/"
RELEASES_PAGE = f"https://github.com/{REPO}/releases"
LICENSE = "GPL-3.0"

# Proxy names, in the order Forge tries them. dxgi.dll is OptiScaler's own
# preferred name; winmm.dll and version.dll are its documented alternatives
# for games that already have a dxgi.dll (ReShade, other overlays) or that
# do not load it from the game folder.
PROXY_NAMES = ("dxgi.dll", "winmm.dll", "version.dll")
# Every name OptiScaler's own setup script treats as an OptiScaler copy.
# Used only to recognise a stray manual install, never to pick one.
ALL_PROXY_NAMES = ("dxgi.dll", "winmm.dll", "d3d12.dll", "dbghelp.dll", "version.dll",
                   "wininet.dll", "winhttp.dll")

MAIN_DLL = "optiscaler.dll"
INI_NAME = "OptiScaler.ini"

# Files of the release archive that are not copied into the game: the
# setup / remove scripts (Forge does their job) and the "extract all files"
# readme.
_SKIP_FILE = re.compile(
    r"(?i)^(setup_windows\.bat|setup_linux\.sh|remove[ _]optiscaler\.bat|"
    r"!!.*\.txt|streamlined_fetcher.*\.bat)$")

REFUSED_TEXT = "Not allowed: anti-cheat (DLL injection)"

# Online-competitive games OptiScaler is refused for on top of every game the
# anti-cheat lock knows (forge_guard.ONLINE_ONLY is added in refusal()).
# These have no kernel anti-cheat in Forge's list - they use VAC, which the
# list leaves out on purpose so mod-first games like Left 4 Dead 2 and
# Garry's Mod stay moddable - but they are ranked online games, and VAC bans
# for injected DLLs: AMD's Anti-Lag+ got Counter-Strike 2 players banned in
# October 2023 for exactly this kind of hook.
COMPETITIVE = {
    570: "Dota 2",
    1422450: "Deadlock",
    440: "Team Fortress 2",
    10: "Counter-Strike",
    240: "Counter-Strike: Source",
}

# A run shorter than this after OptiScaler went in is a failed start (same
# threshold as Forge's way back after a crash).
QUICK_EXIT_SECONDS = 60
# A launcher handing over to the game within this many seconds is one start.
RELAUNCH_SECONDS = 15

UPSCALERS = {
    "fsr4": "FSR 4",
    "fsr31": "FSR 3.1",
    "xess": "XeSS",
    "dlss": "DLSS (passthrough)",
}


# ---- The anti-cheat refusal ----------------------------------------------------

def refusal(verdict: dict, app_id: int, online_only=()) -> dict | None:
    """None when OptiScaler may go into this game, else the refusal.

    Stricter than the mod lock: the per-game override ("Allow mods anyway")
    does NOT apply, because OptiScaler is a hook inside the game's process,
    not a data file. `verdict` is forge_guard.verdict's answer (an override
    keeps "detected" true, which is what is read here)."""
    try:
        app_id = int(app_id or 0)
    except (TypeError, ValueError):
        app_id = 0
    if not app_id:
        return {"ok": False, "not_allowed": True, "anticheat_locked": True, "reason": "game_unknown",
                "error": REFUSED_TEXT,
                "detail": "Forge couldn't tell which game this is, so it can't check it for anti-cheat."}
    v = verdict or {}
    if v.get("detected"):
        what = ", ".join(v.get("products") or []) or "an anti-cheat"
        return {"ok": False, "not_allowed": True, "anticheat_locked": True, "reason": "anticheat",
                "error": REFUSED_TEXT,
                "detail": (f"This game uses {what}. OptiScaler works by loading itself into the game, "
                           "which anti-cheat treats as cheating. There is no override.")}
    if v.get("online_only") or app_id in set(online_only) or app_id in COMPETITIVE:
        return {"ok": False, "not_allowed": True, "anticheat_locked": True, "reason": "competitive",
                "error": REFUSED_TEXT,
                "detail": ("This is an online-competitive game. A DLL loaded into it can get the "
                           "account banned. There is no override.")}
    return None


# ---- The release ---------------------------------------------------------------

def parse_digest(value) -> str:
    """The hex SHA-256 from GitHub's asset `digest` ("sha256:<hex>"), or ""."""
    m = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", str(value or "").strip())
    return m.group(1).lower() if m else ""


def pick_asset(release: dict) -> dict | None:
    """The OptiScaler archive of a release: an asset whose name starts with
    "OptiScaler" and ends in .7z or .zip, not a debug/symbols/source build,
    .7z first (the format OptiScaler publishes). Only a download URL on the
    official repository is accepted. None when there is no such asset."""
    if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
        return None
    found = []
    for a in release.get("assets") or []:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "")
        url = str(a.get("browser_download_url") or "")
        low = name.lower()
        if not re.match(r"optiscaler", low) or not low.endswith((".7z", ".zip")):
            continue
        if re.search(r"debug|pdb|symbol|source|src", low):
            continue
        if not url.startswith(DOWNLOAD_PREFIX) or "/" in name or "\\" in name or ".." in name:
            continue
        found.append({"name": name, "url": url, "size": int(a.get("size") or 0),
                      "sha256": parse_digest(a.get("digest"))})
    if not found:
        return None
    found.sort(key=lambda a: (not a["name"].lower().endswith(".7z"), a["name"].lower()))
    return dict(found[0], tag=str(release.get("tag_name") or ""),
                published=str(release.get("published_at") or ""))


def version_of(tag: str) -> tuple:
    """(0, 9, 5) from "v0.9.5" / "v0.9.2a"; () when it does not parse."""
    m = re.match(r"v?(\d+(?:\.\d+)*)", str(tag or ""))
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def check_hash(pins: dict, asset: dict, sha256: str, accept_change: bool = False) -> dict:
    """Whether a downloaded archive may be used.

    With a GitHub digest: the file must match it ("verified"), else refused.
    Without one: the first hash seen for this release asset is pinned
    ("pinned"); the same hash later is "pinned_match"; a different one is
    refused ("changed") unless the user accepted the change, which re-pins.
    Returns {ok, how, pin} where pin is the value to store (or None)."""
    key = f"{asset.get('tag', '')}/{asset.get('name', '')}"
    sha256 = str(sha256 or "").lower()
    expected = str(asset.get("sha256") or "").lower()
    if expected:
        if sha256 == expected:
            return {"ok": True, "how": "verified", "key": key, "pin": sha256}
        return {"ok": False, "how": "digest_mismatch", "key": key, "pin": None,
                "error": ("The download does not match the SHA-256 GitHub publishes for it, "
                          "so it was not installed.")}
    old = str((pins or {}).get(key) or "").lower()
    if not old:
        return {"ok": True, "how": "pinned", "key": key, "pin": sha256}
    if old == sha256:
        return {"ok": True, "how": "pinned_match", "key": key, "pin": sha256}
    if accept_change:
        return {"ok": True, "how": "repinned", "key": key, "pin": sha256}
    return {"ok": False, "how": "changed", "key": key, "pin": None, "hash_changed": True,
            "error": (f"{asset.get('name', 'The download')} has changed since Forge first installed it "
                      f"(SHA-256 {old[:12]}... then, {sha256[:12]}... now) and GitHub publishes no "
                      "digest to check it against. Install only if you trust the change.")}


# ---- GPU and graphics API ------------------------------------------------------

# RDNA 4: Radeon RX 9000 series and the Radeon AI PRO R9000 cards (Navi 48 /
# Navi 44). PCI device ids 0x7550 (Navi 48) and 0x7590 (Navi 44).
_RDNA4_NAME = re.compile(r"(?i)radeon.*\b(rx\s*9\d{3}|ai\s*pro\s*r9\d{3})\b")
_RDNA4_DEV = re.compile(r"(?i)ven_1002&dev_(7550|7551|7590)")


def gpu_info(adapters) -> dict:
    """{vendor, rdna4, names} from Win32_VideoController rows
    ({name, pnp}). vendor is the best discrete-looking adapter's: "amd",
    "nvidia", "intel" or "" (unknown)."""
    names, vendors, rdna4 = [], [], False
    for a in adapters or []:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "").strip()
        pnp = str(a.get("pnp") or "")
        if not name or re.search(r"(?i)basic display|remote|virtual|parsec|meta", name):
            continue
        names.append(name)
        low = (name + " " + pnp).lower()
        if "nvidia" in low or "ven_10de" in low:
            vendors.append("nvidia")
        elif "radeon" in low or "amd" in low or "ven_1002" in low:
            vendors.append("amd")
            rdna4 = rdna4 or bool(_RDNA4_NAME.search(name) or _RDNA4_DEV.search(pnp))
        elif "intel" in low or "ven_8086" in low:
            arc = bool(re.search(r"(?i)\barc\b", name))
            vendors.append("intel-arc" if arc else "intel")
    # A discrete card wins over an integrated one listed first.
    for want in ("nvidia", "amd", "intel-arc", "intel"):
        if want in vendors:
            vendor = want
            break
    else:
        vendor = ""
    return {"vendor": vendor, "rdna4": rdna4, "names": names}


def upscaler_choices(gpu: dict) -> dict:
    """The upscalers to offer and the default. FSR 4 only on RDNA 4, DLSS
    only on an NVIDIA card (it is passed through, not emulated); FSR 3.1 and
    XeSS run anywhere."""
    gpu = gpu or {}
    choices = []
    if gpu.get("rdna4"):
        choices.append("fsr4")
    choices.append("fsr31")
    choices.append("xess")
    if gpu.get("vendor") == "nvidia":
        choices.append("dlss")
    if gpu.get("rdna4"):
        default = "fsr4"
    elif gpu.get("vendor") == "nvidia":
        default = "dlss"
    elif gpu.get("vendor") == "intel-arc":
        default = "xess"
    else:
        default = "fsr31"
    return {"choices": choices, "default": default,
            "labels": {c: UPSCALERS[c] for c in choices}}


def graphics_apis(is64: bool, imports) -> dict:
    """What the exe's import table says about its graphics API.

    {ok, apis, reason}: refused for a 32-bit exe (OptiScaler is 64-bit only)
    and for an exe that imports DirectX 8/9 or OpenGL and none of DirectX
    11/12, DXGI or Vulkan. An exe that imports none of them is "unknown" and
    allowed: many games load d3d12 at run time."""
    low = {str(i).lower() for i in imports or []}
    apis = []
    if "d3d12.dll" in low:
        apis.append("dx12")
    if "d3d11.dll" in low:
        apis.append("dx11")
    if "vulkan-1.dll" in low:
        apis.append("vulkan")
    if "dxgi.dll" in low and not apis:
        apis.append("dxgi")
    old = [n for n, a in (("d3d9.dll", "dx9"), ("d3d8.dll", "dx8"), ("opengl32.dll", "opengl"))
           if n in low]
    if not low:
        return {"ok": True, "apis": [], "reason": "unknown", "is64": bool(is64)}
    if not is64:
        return {"ok": False, "apis": apis, "reason": "32bit", "is64": False,
                "error": "This game is 32-bit. OptiScaler only works with 64-bit games."}
    if not apis and old:
        return {"ok": False, "apis": old, "reason": "old_api", "is64": True,
                "error": "This game uses DirectX 9 or OpenGL. OptiScaler needs DirectX 11, 12 or Vulkan."}
    return {"ok": True, "apis": apis, "reason": "" if apis else "unknown", "is64": True}


# ---- Where it goes -------------------------------------------------------------

_NOT_GAME_EXE = re.compile(
    r"(?i)(crash|unins|redist|vc_?redist|dxsetup|dotnet|setup|install|launcher|helper|report|"
    r"easyanticheat|battleye|start_protected|ue4prereq|ueprereq|cefprocess|webhelper|update|"
    r"benchmark|server|editor|config|settings)")
_SKIP_DIRS = {"engine", "_commonredist", "redist", "redistributables", "__installer",
              "directx", "support", "easyanticheat", "battleye", "_redist"}


def pick_exe(candidates, hint: str = "") -> str:
    """The game exe OptiScaler goes next to, as a path relative to the game
    folder ("/"-separated), from [(rel, size)].

    The hint (the plugin's own processName for a managed game) wins when it
    is one of the candidates. Otherwise an Unreal "-Shipping" exe, else the
    biggest exe that is not a launcher, crash handler, installer or tool,
    outside Engine/ and redistributable folders. "" when nothing fits."""
    rows = []
    for rel, size in candidates or []:
        rel = str(rel).replace("\\", "/").strip("/")
        if not rel.lower().endswith(".exe") or any(p in ("", ".", "..") for p in rel.split("/")):
            continue
        rows.append((rel, int(size or 0)))
    if not rows:
        return ""
    if hint:
        h = str(hint).replace("\\", "/").strip("/").lower()
        h_exe = h if h.endswith(".exe") else h + ".exe"
        for rel, _s in rows:
            low = rel.lower()
            if low in (h, h_exe):
                return rel
        base = h_exe.split("/")[-1]
        named = [r for r in rows if r[0].lower().split("/")[-1] == base]
        if len(named) == 1:
            return named[0][0]
    usable = [r for r in rows
              if not any(p.lower() in _SKIP_DIRS for p in r[0].split("/")[:-1])
              and not _NOT_GAME_EXE.search(r[0].split("/")[-1].replace("shipping", ""))]
    shipping = [r for r in usable if re.search(r"(?i)-(win64|wingdk)-shipping\.exe$", r[0])]
    if shipping:
        return max(shipping, key=lambda r: r[1])[0]
    if not usable:
        return ""
    return max(usable, key=lambda r: (r[1], -r[0].count("/")))[0]


def choose_proxy(present, reserved=(), backed_up=(), requested: str = "") -> dict:
    """The proxy name OptiScaler is installed as, next to the exe.

    present: names (lower-case) already in the exe's folder. reserved: names
    another Forge tool owns there (ReShade's DLL), never replaced. backed_up:
    names that already have a .nexusbak beside them (another mod's backup),
    never replaced either, since that backup would be lost.

    The first free name in PROXY_NAMES wins. When all are taken, the first
    one that is neither reserved nor already backed up is replaced (and
    backed up). A requested name is used if it is one of PROXY_NAMES and not
    reserved / backed up. {name, replaces} or {error}."""
    present = {p.lower() for p in present or []}
    reserved = {p.lower() for p in reserved or []}
    backed_up = {p.lower() for p in backed_up or []}
    order = list(PROXY_NAMES)
    if requested:
        req = requested.lower()
        if req not in PROXY_NAMES:
            return {"error": f"{requested} is not a name Forge installs OptiScaler as."}
        if req in reserved:
            return {"error": f"{requested} belongs to ReShade in this game. Pick another name."}
        if req in present and req in backed_up:
            return {"error": f"{requested} already has a backup from another mod. Pick another name."}
        return {"name": req, "replaces": req in present}
    for n in order:
        if n not in present and n not in reserved:
            return {"name": n, "replaces": False}
    for n in order:
        if n not in reserved and n not in backed_up:
            return {"name": n, "replaces": True}
    return {"error": "Every name OptiScaler can use is taken by another mod in this game's folder."}


def next_proxy(current: str) -> str:
    """The name after `current` in PROXY_NAMES (wrapping round)."""
    cur = str(current or "").lower()
    if cur not in PROXY_NAMES:
        return PROXY_NAMES[0]
    return PROXY_NAMES[(PROXY_NAMES.index(cur) + 1) % len(PROXY_NAMES)]


def archive_root(rel_files) -> str:
    """The folder inside the unpacked archive that holds OptiScaler.dll
    ("/"-separated, "" for the top), or None when it is not there."""
    best = None
    for f in rel_files or []:
        f = str(f).replace("\\", "/")
        parts = f.split("/")
        if parts[-1].lower() == MAIN_DLL:
            root = "/".join(parts[:-1])
            if best is None or root.count("/") < best.count("/"):
                best = root
    return best


def plan_files(rel_files, proxy: str) -> list:
    """[(source rel in the archive, destination rel next to the exe)] for
    every file of the release: OptiScaler.dll becomes the proxy, the shipped
    OptiScaler.ini is left out (Forge writes its own), the setup scripts and
    the readme are skipped. Files outside OptiScaler.dll's folder are not
    part of the install. [] when the archive has no OptiScaler.dll."""
    root = archive_root(rel_files)
    if root is None:
        return []
    prefix = root + "/" if root else ""
    out = []
    for f in rel_files or []:
        f = str(f).replace("\\", "/")
        if f.endswith("/") or not f.startswith(prefix):
            continue
        rest = f[len(prefix):]
        parts = rest.split("/")
        if any(p in ("", ".", "..") for p in parts):
            continue
        name = parts[-1]
        if len(parts) == 1:
            if name.lower() == MAIN_DLL:
                out.append((f, proxy))
                continue
            if name.lower() == INI_NAME.lower() or _SKIP_FILE.match(name):
                continue
        out.append((f, rest))
    return out


# ---- OptiScaler.ini --------------------------------------------------------------

def upscaler_family(shipped_ini: str) -> str:
    """Which value names the release's OptiScaler.ini documents for FSR 3.1
    and FSR 4: "fsr31" (releases up to 0.9.x: fsr31 / fsr31_12) or "ffx"
    (newer: ffx / ffx_12). Read from the comment above Dx12Upscaler, since
    the names changed between releases; "fsr31" when it cannot be told."""
    text = str(shipped_ini or "")
    m = re.search(r"((?:^;[^\n]*\n)+)\s*Dx12Upscaler\s*=", text, re.M)
    comment = m.group(1) if m else ""
    if re.search(r"\bffx\b", comment) and not re.search(r"\bfsr31\b", comment):
        return "ffx"
    return "fsr31"


def ini_values(upscaler: str, family: str = "fsr31") -> dict:
    """{section: {key: value}} for the user's upscaler, all three APIs set
    (Forge cannot always tell which one the game uses).

    FSR 4 and FSR 3.1 both go through OptiScaler's FFX backend, with
    [FSR] UpscalerIndex picking the version (0 = FSR 4, 1 = FSR 3.1). DX11
    and Vulkan reach FSR 4 through OptiScaler's "on 12" path."""
    ffx = "ffx" if family == "ffx" else "fsr31"
    if upscaler == "fsr4":
        up = {"Dx11Upscaler": f"{ffx}_12", "Dx12Upscaler": ffx, "VulkanUpscaler": f"{ffx}_12"}
        fsr = {"UpscalerIndex": "0"}
    elif upscaler == "fsr31":
        up = {"Dx11Upscaler": "fsr31" if ffx == "fsr31" else "ffx_12", "Dx12Upscaler": ffx,
              "VulkanUpscaler": ffx}
        fsr = {"UpscalerIndex": "1"}
    elif upscaler == "xess":
        up = {"Dx11Upscaler": "xess_12", "Dx12Upscaler": "xess", "VulkanUpscaler": "xess"}
        fsr = {}
    elif upscaler == "dlss":
        up = {"Dx11Upscaler": "dlss", "Dx12Upscaler": "dlss", "VulkanUpscaler": "dlss"}
        fsr = {}
    else:
        raise ValueError(f"unknown upscaler {upscaler!r}")
    out = {"Upscalers": up}
    if fsr:
        out["FSR"] = fsr
    # The startup splash is OptiScaler's "press Insert for the menu" hint.
    # The overlay itself stays on its key (Insert) for anyone who wants it.
    out["Menu"] = {"DisableSplash": "true"}
    return out


def render_ini(upscaler: str, family: str = "fsr31", version: str = "") -> str:
    """A minimal OptiScaler.ini: only the keys Forge sets. Every key left
    out takes OptiScaler's own default (auto)."""
    lines = ["; Written by Forge for OptiScaler" + (f" {version}" if version else "") + ".",
             f"; Upscaler: {UPSCALERS.get(upscaler, upscaler)}. Keys not listed here use OptiScaler's",
             "; defaults (auto). Press Insert in game for OptiScaler's own menu.", ""]
    for section, keys in ini_values(upscaler, family).items():
        lines.append(f"[{section}]")
        lines += [f"{k}={v}" for k, v in keys.items()]
        lines.append("")
    return "\r\n".join(lines)


# ---- Failure safety --------------------------------------------------------------

def on_launch(rec: dict, now: float) -> dict:
    """The game started with OptiScaler in. A second start within
    RELAUNCH_SECONDS (a launcher handing over) keeps the first time."""
    if not rec or not rec.get("files"):
        return rec
    started = float(rec.get("session_started") or 0)
    if started and now - started < RELAUNCH_SECONDS:
        return rec
    return dict(rec, session_started=now)


def on_exit(rec: dict, now: float, crashed: bool = False) -> tuple:
    """(new record, event). Until the first clean run after OptiScaler went
    in (or was updated), a crash report or a run shorter than
    QUICK_EXIT_SECONDS marks it suspect: the game page then offers a
    one-press removal. event: "" (nothing to say), "clean", "suspect" (first
    time: notify) or "suspect_again"."""
    if not rec or not rec.get("files"):
        return rec, ""
    started = float(rec.get("session_started") or 0)
    rec = {k: v for k, v in rec.items() if k != "session_started"}
    if not started or started < float(rec.get("installed_at") or 0):
        return rec, ""
    if rec.get("verified"):
        return rec, ""
    failed = crashed or (now - started) < QUICK_EXIT_SECONDS
    if not failed:
        rec = {k: v for k, v in rec.items() if k != "suspect"}
        return dict(rec, verified=True), "clean"
    kind = "crash" if crashed else "quick"
    again = bool(rec.get("suspect"))
    return dict(rec, suspect={"at": int(now), "kind": kind}), ("suspect_again" if again else "suspect")


def summary(rec: dict) -> dict:
    """What the game page shows about an installed OptiScaler."""
    rec = rec or {}
    if not rec.get("files"):
        return {"installed": False}
    return {
        "installed": True,
        "version": str(rec.get("version") or ""),
        "upscaler": str(rec.get("upscaler") or ""),
        "upscaler_label": UPSCALERS.get(str(rec.get("upscaler") or ""), ""),
        "proxy": str(rec.get("proxy") or ""),
        "exe": str(rec.get("exe") or ""),
        "installed_at": int(rec.get("installed_at") or 0),
        "hash_how": str(rec.get("hash_how") or ""),
        "verified": bool(rec.get("verified")),
        "suspect": rec.get("suspect") if isinstance(rec.get("suspect"), dict) else None,
        "backups": len(rec.get("backups") or []),
    }


def rel_join(*parts) -> str:
    return "/".join(p.strip("/") for p in parts if p and p.strip("/"))


def norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))
