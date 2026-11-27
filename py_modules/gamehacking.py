"""PS2 cheats (.pnach) from GameHacking.org, for the user's personal use.

Status: used for Vonn's private, non-commercial use while he asks the site
for permission. If they refuse, set GAMEHACKING_ENABLED to False (one line)
and the source is gone: every callable refuses, the UI shows only the
link-out. The user can also switch it off in Settings ("GameHacking.org
cheats").

A polite personal-use client, not a scraper:

- Only when the user asks for cheats for ONE game. Never bulk, never in the
  background, never prefetched.
- robots.txt is read (cached a day) before any other request and obeyed:
  a disallowed path is not requested; the UI links out and says why.
- At most MAX_REQUESTS_PER_ACTION requests per user action, at least
  MIN_SPACING seconds apart, with an honest User-Agent
  ("Forge/<version> (personal use)").
- Results are cached per game for a week (the game lookup and the .pnach).
- 429 / 5xx back off (Retry-After honoured, at least BACKOFF_SECONDS), and
  after MAX_FAILURES failures in a session the source stops until the plugin
  reloads.
- Only what a visitor's browser gets: the system list page, the game page,
  and the game page's own code export in pnach format. No login, no cookies
  kept, no protection bypassed, no CAPTCHA solved: a bot check or an HTML
  answer where a file was expected falls back to the link-out.

Site structure (read from the site's own pages as a browser sees them, as
documented by a public open-source client; never verified from this PC):
- ``/system/ps2/all`` - a table of games: a row per game with a link to
  ``/game/<id>`` and the serial in its second cell; pagination links to more
  list pages (``/system/ps2/all...``).
- ``/game/<id>`` - the game's codes and an export form with hidden inputs
  ``sysID`` and ``gamID`` and a ``format`` select (one option is pnach).
- ``POST /inc/sub.exportCodes.php`` with ``format``, ``codID`` (empty: all),
  ``filename``, ``sysID``, ``gamID``, ``download=true`` - the export.
Anything that does not look like this is treated as "not available" and
links out.
"""
import json
import os
import re
import sys
import time
import urllib.parse

try:
    from html.parser import HTMLParser
except ImportError:
    sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_stdlib_compat"))
    from html_parser import HTMLParser

# One line to remove the source if the site says no.
GAMEHACKING_ENABLED = True

SITE = "https://gamehacking.org"
SYSTEM = "ps2"
LIST_PATH = f"/system/{SYSTEM}/all"
EXPORT_PATH = "/inc/sub.exportCodes.php"
LINK_OUT = f"{SITE}/system/{SYSTEM}"
UA_TOKEN = "Forge"

MIN_SPACING = 1.0
MAX_REQUESTS_PER_ACTION = 4
MAX_FAILURES = 3
BACKOFF_SECONDS = 120
MAX_BACKOFF_SECONDS = 3600
CACHE_TTL = 7 * 86400
ROBOTS_TTL = 86400
MAX_PNACH_BYTES = 2 * 1024 * 1024


def user_agent(version: str) -> str:
    return f"Forge/{version or 'dev'} (personal use)"


# ---- robots.txt ----------------------------------------------------------------


def parse_robots(text: str) -> list:
    """[(agents, rules)] groups; rules are (allow: bool, pattern)."""
    groups = []
    agents, rules, last_was_agent = [], [], False
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (p.strip() for p in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if not last_was_agent and (agents or rules):
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value.lower())
            last_was_agent = True
        elif key in ("allow", "disallow"):
            last_was_agent = False
            if agents and (value or key == "allow"):
                rules.append((key == "allow", value))
        else:
            last_was_agent = False
    if agents or rules:
        groups.append((agents, rules))
    return groups


def _pattern_match(pattern: str, path: str):
    """Length of the match when `pattern` (with * and $) matches `path`'s start."""
    if not pattern:
        return None
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    rx = "^" + ".*".join(re.escape(p) for p in body.split("*")) + ("$" if anchored else "")
    return len(pattern) if re.match(rx, path) else None


def robots_allows(groups: list, agent: str, path: str) -> bool:
    """RFC 9309: the group naming our agent (else "*"); the longest matching
    rule wins, Allow on a tie; nothing matching allows."""
    token = agent.lower()
    chosen = [g for g in groups if any(a != "*" and a in token for a in g[0])]
    if not chosen:
        chosen = [g for g in groups if "*" in g[0]]
    best = None
    for _agents, rules in chosen:
        for allow, pattern in rules:
            n = _pattern_match(pattern, path)
            if n is None:
                continue
            if best is None or n > best[0] or (n == best[0] and allow):
                best = (n, allow)
    return True if best is None else best[1]


# ---- Pages -------------------------------------------------------------------------


class _ListParser(HTMLParser):
    """Rows with a /game/ link: (title, href, serial); and list-page links."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.pages = [], []
        self._row = None
        self._cell = -1
        self._cell_text = []
        self._in_a = None
        self._a_text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self._row = {"cells": [], "game": None, "title": ""}
        elif tag in ("td", "th") and self._row is not None:
            self._cell_text = []
        elif tag == "a":
            href = a.get("href") or ""
            self._in_a = href
            self._a_text = []

    def handle_endtag(self, tag):
        if tag == "a" and self._in_a is not None:
            href, text = self._in_a, " ".join("".join(self._a_text).split())
            if "/game/" in href and self._row is not None and not self._row["game"]:
                self._row["game"], self._row["title"] = href, text
            elif href.startswith(LIST_PATH) or f"{SITE}{LIST_PATH}" in href:
                self.pages.append((href, text))
            self._in_a = None
        elif tag in ("td", "th") and self._row is not None:
            self._row["cells"].append(" ".join("".join(self._cell_text).split()))
        elif tag == "tr" and self._row is not None:
            if self._row["game"]:
                cells = self._row["cells"]
                self.rows.append({"title": self._row["title"], "href": self._row["game"],
                                  "serial": cells[1] if len(cells) > 1 else ""})
            self._row = None

    def handle_data(self, data):
        if self._row is not None:
            self._cell_text.append(data)
        if self._in_a is not None:
            self._a_text.append(data)


def parse_list(html_text: str) -> dict:
    p = _ListParser()
    p.feed(html_text or "")
    seen, pages = set(), []
    for href, text in p.pages:
        if href not in seen:
            seen.add(href)
            pages.append({"href": href, "label": text})
    return {"games": p.rows, "pages": pages}


class _FormParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inputs = {}
        self.formats = []
        self._in_format = False
        self._opt = None
        self._opt_text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "input" and a.get("name") in ("sysID", "gamID"):
            self.inputs[a["name"]] = a.get("value") or ""
        elif tag == "select" and a.get("name") == "format":
            self._in_format = True
        elif tag == "option" and self._in_format:
            self._opt = a.get("value") or ""
            self._opt_text = []

    def handle_endtag(self, tag):
        if tag == "option" and self._opt is not None:
            self.formats.append((self._opt, " ".join("".join(self._opt_text).split())))
            self._opt = None
        elif tag == "select":
            self._in_format = False

    def handle_data(self, data):
        if self._opt is not None:
            self._opt_text.append(data)


def parse_game_page(html_text: str) -> dict:
    """{sysID, gamID, format} for the export, or {} when the page has no
    export form or no pnach format (then: link out)."""
    p = _FormParser()
    p.feed(html_text or "")
    fmt = next((v for v, label in p.formats if "pnach" in (v + " " + label).lower()), "")
    if not (p.inputs.get("sysID") and p.inputs.get("gamID") and fmt):
        return {}
    return {"sysID": p.inputs["sysID"], "gamID": p.inputs["gamID"], "format": fmt}


def looks_like_html(data: bytes) -> bool:
    head = (data or b"")[:512].lstrip().lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html") or b"<head" in head[:200]


def looks_like_bot_check(status: int, data: bytes) -> bool:
    low = (data or b"")[:4096].lower()
    return status in (403, 503) or any(w in low for w in (b"captcha", b"cf-chl", b"challenge-platform",
                                                          b"just a moment", b"are you a robot"))


def valid_pnach(data: bytes) -> bool:
    """A pnach export: text, not a web page, with at least one patch line."""
    if not data or len(data) > MAX_PNACH_BYTES or looks_like_html(data) or b"\x00" in data[:4096]:
        return False
    return re.search(rb"(?im)^\s*patch\s*=", data) is not None


def export_body(page: dict, filename: str) -> str:
    return urllib.parse.urlencode({"format": page["format"], "codID": "", "filename": filename,
                                   "sysID": page["sysID"], "gamID": page["gamID"], "download": "true"})


def filename_from_disposition(header: str) -> str:
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', header or "", re.I)
    return urllib.parse.unquote(m.group(1)).strip() if m else ""


# ---- Matching ---------------------------------------------------------------------


def norm_serial(s: str) -> str:
    """"SLUS-20946", "SLUS_209.46", "slus20946" -> "SLUS20946"."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def norm_title(s: str) -> str:
    s = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", s or "")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def match_games(games: list, serial: str, title: str) -> list:
    """Games best first: an exact serial match (several serials in a cell
    count), then the same title, then titles sharing most words."""
    want_s = norm_serial(serial)
    want_t = norm_title(title)
    out = []
    for g in games or []:
        serials = [norm_serial(x) for x in re.split(r"[,/;\s]+", g.get("serial") or "") if x]
        gt = norm_title(g.get("title") or "")
        if want_s and want_s in serials:
            score = 100
        elif want_t and gt == want_t:
            score = 80
        else:
            a, b = set(want_t.split()), set(gt.split())
            overlap = len(a & b) / max(1, len(a | b))
            if overlap < 0.6:
                continue
            score = 30 + int(overlap * 30)
        out.append(dict(g, score=score))
    out.sort(key=lambda g: (-g["score"], g.get("title") or ""))
    return out


def page_for(pages: list, title: str):
    """The list page for a title's first character, when the list is split by
    letter (labels like "A", "B", "#", "0-9"); None otherwise."""
    t = norm_title(title)
    if not t:
        return None
    first = t[0].upper()
    for p in pages or []:
        label = (p.get("label") or "").strip().upper()
        if label == first or (first.isdigit() and label in ("#", "0-9", "0")):
            return p
    return None


def abs_url(href: str) -> str:
    return href if href.startswith("https://") else urllib.parse.urljoin(SITE + "/", href)


def same_site(url: str) -> bool:
    u = urllib.parse.urlsplit(url)
    return u.scheme == "https" and u.netloc in ("gamehacking.org", "www.gamehacking.org")


def game_path_ok(href: str) -> bool:
    url = abs_url(href)
    return same_site(url) and re.fullmatch(r"/game/[0-9A-Za-z_-]+/?", urllib.parse.urlsplit(url).path) is not None


# ---- The client --------------------------------------------------------------------


class Unavailable(Exception):
    """GameHacking.org can't be used right now; .reason says why (shown with
    the link-out)."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


class Client:
    """transport(method, url, headers, body) -> (status, headers, bytes);
    clock() and sleep(seconds) are injected for tests. One instance per
    plugin session: the failure count and back-off live here."""

    def __init__(self, transport, version: str, cache_dir: str, clock=time.time, sleep=None):
        self.transport = transport
        self.ua = user_agent(version)
        self.cache_dir = cache_dir
        self.clock = clock
        self.sleep = sleep
        self.failures = 0
        self.backoff_until = 0.0
        self.last_request = 0.0
        self.robots = None
        self.robots_at = 0.0

    # -- guards
    def _check_open(self):
        if not GAMEHACKING_ENABLED:
            raise Unavailable("removed", "GameHacking.org isn't used by this build of Forge.")
        if self.failures >= MAX_FAILURES:
            raise Unavailable("stopped", "GameHacking.org failed several times, so Forge stopped asking it until the plugin reloads.")
        if self.clock() < self.backoff_until:
            raise Unavailable("backoff", "GameHacking.org asked Forge to slow down; try again later.")

    def _fail(self, status: int = 0, retry_after: str = ""):
        self.failures += 1
        wait = BACKOFF_SECONDS
        try:
            wait = max(wait, min(MAX_BACKOFF_SECONDS, int(retry_after)))
        except (TypeError, ValueError):
            pass
        if status == 429 or status >= 500 or status == 0:
            self.backoff_until = self.clock() + wait

    async def _request(self, budget: list, method: str, path_or_url: str, body: str = "", referer: str = ""):
        """One polite request: inside the action's budget, robots-checked,
        spaced, with the honest User-Agent."""
        self._check_open()
        url = abs_url(path_or_url)
        if not same_site(url):
            raise Unavailable("bad_url", "Not a GameHacking.org address.")
        path = urllib.parse.urlsplit(url).path or "/"
        if not await self._allowed(budget, path):
            raise Unavailable("robots", f"GameHacking.org's robots.txt asks programs not to fetch {path}, so Forge doesn't.")
        return await self._send(budget, method, url, body, referer)

    async def _send(self, budget: list, method: str, url: str, body: str = "", referer: str = ""):
        if budget[0] <= 0:
            raise Unavailable("budget", "Forge stops after a few requests per press; press again to continue.")
        budget[0] -= 1
        gap = self.clock() - self.last_request
        if self.last_request and gap < MIN_SPACING and self.sleep:
            await self.sleep(MIN_SPACING - gap)
        self.last_request = self.clock()
        headers = {"User-Agent": self.ua, "Accept": "text/html,text/plain,*/*"}
        if body:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if referer:
            headers["Referer"] = referer
        try:
            status, rheaders, data = await self.transport(method, url, headers, body)
        except Exception as e:  # noqa: BLE001 - a network failure is a failure
            self._fail(0)
            raise Unavailable("network", f"GameHacking.org didn't answer ({type(e).__name__}).")
        if status == 429 or status >= 500:
            self._fail(status, (rheaders or {}).get("Retry-After", ""))
            raise Unavailable("busy", f"GameHacking.org is busy (HTTP {status}); Forge will wait before asking again.")
        if looks_like_bot_check(status, data):
            self._fail(status)
            raise Unavailable("bot_check", "GameHacking.org shows a browser check, which Forge doesn't get past. Open it in the browser instead.")
        if status != 200:
            self._fail(status)
            raise Unavailable("http", f"GameHacking.org answered HTTP {status}.")
        return rheaders or {}, data

    async def _allowed(self, budget: list, path: str) -> bool:
        if self.robots is None or self.clock() - self.robots_at > ROBOTS_TTL:
            cached = self._cache_get("robots", ROBOTS_TTL)
            if cached is not None:
                self.robots = parse_robots(cached.get("text") or "")
                self.robots_at = self.clock()
            else:
                try:
                    _h, data = await self._send(budget, "GET", SITE + "/robots.txt")
                    text = data.decode("utf-8", "replace")
                except Unavailable as e:
                    if e.reason == "http":
                        text = ""  # no robots.txt (404): everything allowed
                        self.failures = max(0, self.failures - 1)
                    else:
                        raise
                self.robots = parse_robots(text)
                self.robots_at = self.clock()
                self._cache_put("robots", {"text": text})
        return robots_allows(self.robots, UA_TOKEN, path)

    # -- cache
    def _cache_path(self, key: str) -> str:
        return os.path.join(self.cache_dir, re.sub(r"[^A-Za-z0-9_.-]+", "_", key)[:120] + ".json")

    def _cache_get(self, key: str, ttl: float):
        try:
            with open(self._cache_path(key), encoding="utf-8") as f:
                got = json.load(f)
            if self.clock() - float(got.get("at") or 0) < ttl:
                return got.get("value")
        except (OSError, ValueError, AttributeError):
            pass
        return None

    def _cache_put(self, key: str, value) -> None:
        try:
            os.makedirs(self.cache_dir, exist_ok=True)
            tmp = self._cache_path(key) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"at": self.clock(), "value": value}, f)
            os.replace(tmp, self._cache_path(key))
        except OSError:
            pass

    # -- actions (one user press each)
    async def find(self, serial: str, title: str) -> list:
        """Games matching the ROM, best first ([{title, href, serial, score}]).
        At most two list pages are read; the answer is cached a week."""
        key = f"find-{norm_serial(serial)}-{norm_title(title)}"
        cached = self._cache_get(key, CACHE_TTL)
        if cached is not None:
            return cached
        budget = [MAX_REQUESTS_PER_ACTION]
        _h, data = await self._request(budget, "GET", LIST_PATH)
        listing = parse_list(data.decode("utf-8", "replace"))
        found = match_games(listing["games"], serial, title)
        if not found or found[0]["score"] < 100:
            page = page_for(listing["pages"], title)
            if page and abs_url(page["href"]) != abs_url(LIST_PATH):
                _h, more = await self._request(budget, "GET", page["href"])
                found = match_games(parse_list(more.decode("utf-8", "replace"))["games"], serial, title) or found
        found = [g for g in found if game_path_ok(g.get("href") or "")][:10]
        self.failures = 0
        self._cache_put(key, found)
        return found

    async def pnach(self, game_href: str, filename: str) -> dict:
        """{data (text), name} for a game's pnach export: its page, then its
        own export. Cached a week per game."""
        if not game_path_ok(game_href):
            raise Unavailable("bad_url", "Not a GameHacking.org game page.")
        url = abs_url(game_href)
        key = f"pnach-{urllib.parse.urlsplit(url).path}"
        cached = self._cache_get(key, CACHE_TTL)
        if cached is not None:
            return cached
        budget = [MAX_REQUESTS_PER_ACTION]
        _h, page_html = await self._request(budget, "GET", url)
        form = parse_game_page(page_html.decode("utf-8", "replace"))
        if not form:
            raise Unavailable("no_export", "This game's page on GameHacking.org offers no pnach export Forge recognises.")
        headers, data = await self._request(budget, "POST", EXPORT_PATH, export_body(form, filename), referer=url)
        if not valid_pnach(data):
            self._fail(200)
            raise Unavailable("not_pnach", "GameHacking.org sent something that isn't a pnach file.")
        name = filename_from_disposition(headers.get("Content-Disposition", "")) or f"{filename}.pnach"
        if not name.lower().endswith(".pnach"):
            name += ".pnach"
        out = {"data": data.decode("utf-8", "replace"), "name": name}
        self.failures = 0
        self._cache_put(key, out)
        return out
