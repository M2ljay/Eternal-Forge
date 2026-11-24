"""New VR mod releases: MRSURVIV0R's VR HUB and other VR mods on GitHub
(their releases.atom feeds) and VR mods on Nexus for the games the
plugin manages. Parsing and matching only; fetching lives in main.py.
"""

from __future__ import annotations

import datetime
import html
import re
import xml.etree.ElementTree as ET

HUB_REPO = "MrSurviv0r/MRSURVIV0R-S-VR-HUB"
_ATOM = "{http://www.w3.org/2005/Atom}"
_REPO_RE = re.compile(r"^(?:https?://github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?(?:[#?].*)?$")
# A mod about VR: the word VR on its own (not "VRAM", "VRR"), or the
# usual VR framework names.
VR_RE = re.compile(r"(?<![A-Za-z])VR(?![A-Za-z])|virtual reality|\bUEVR\b|OpenXR|OpenVR|6DoF|\bvorpx\b|"
                   r"\bflat2vr\b|motion controls? in vr", re.I)


def repo_slug(text: str) -> str:
    """'owner/repo' from a GitHub link or slug, or ''."""
    m = _REPO_RE.match((text or "").strip())
    if not m:
        return ""
    owner, repo = m.group(1), m.group(2)
    if owner.lower() in ("orgs", "users", "settings", "marketplace"):
        return ""
    return f"{owner}/{repo}"


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _strip(markup: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", markup or ""))).strip()


def parse_atom(xml_text: str, limit: int = 8) -> list:
    """[{id, title, url, date (epoch), text}] from a GitHub releases feed."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out = []
    for e in root.findall(f"{_ATOM}entry")[:limit]:
        link = e.find(f"{_ATOM}link")
        when = _text(e.find(f"{_ATOM}updated"))
        try:
            ts = int(datetime.datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp())
        except ValueError:
            ts = 0
        out.append({"id": _text(e.find(f"{_ATOM}id")), "title": _text(e.find(f"{_ATOM}title")),
                    "url": link.get("href") if link is not None else "", "date": ts,
                    "text": _strip(_text(e.find(f"{_ATOM}content")))[:4000]})
    return out


def is_vr(name: str, summary: str = "") -> bool:
    return bool(VR_RE.search(name or "") or VR_RE.search(summary or ""))


def _norm(s: str) -> str:
    s = re.sub(r"[™®©:'’\-–—!.,()]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def mentioned_games(text: str, game_names: list) -> list:
    """Which of the user's games a release note names."""
    body = " " + _norm(text) + " "
    hits = []
    for name in game_names or []:
        n = _norm(name)
        # "Portal" is not named by "Portal 2": a sequel number right after
        # the name makes it a different game.
        if len(n) >= 4 and re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])(?! (?:\d+|ii|iii|iv|v)\b)", body):
            hits.append(name)
    return sorted(set(hits))


def teaser(text: str, n: int = 140) -> str:
    t = (text or "").strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"
