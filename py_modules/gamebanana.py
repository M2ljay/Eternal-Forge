"""GameBanana as a second mod source: browse a game's mods, read a mod's
page and files, resolve a Steam game to a GameBanana game, and tell when an
installed GameBanana file has a newer upload.

No account and no key: every call here is a public read. The transport is
injected (``Client(transport)``, where ``transport(url)`` returns
``(status, text)``) so the whole module runs against recorded or synthetic
answers in tests; main.py supplies the real one over aiohttp.

Endpoints, and how sure we are of each (docs/gamebanana.md has the detail):

- ``apiv11/Mod/Index?_aFilters[Generic_Game]=ID&_nPage=&_nPerpage=`` - the
  list behind the site's game pages. Used by other mod managers; the
  ``_sSort`` names are not documented, so a sort the server rejects falls
  back to its default order instead of failing the page.
- ``apiv11/Util/Search/Results?_sModelName=Mod&_idGameRow=ID&_sSearchString=``
  - the site's search.
- ``apiv11/Mod/{id}/ProfilePage`` - a mod's page: text, images, files.
- ``api.gamebanana.com/Core/Item/Data`` (documented, multicall) - the files
  of up to 20 mods per request for update checks, and a game's name by id.
- ``apiv11/Util/Game/NameMatch?_sName=`` - games by name, for linking.
- ``https://gamebanana.com/dl/{file id}`` - the file itself; redirects to
  files.gamebanana.com. No session needed.

GameBanana ids are moved into their own range before they reach the
install pipeline (``to_local``), which keys archives, progress, install
records and restore points by integer mod and file ids. A Nexus id never
reaches 10^9, so the two can never collide, and any code that still asks
Nexus about one gets "no such mod" rather than an unrelated mod.
"""

from __future__ import annotations

import asyncio
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.parse

try:
    from html.parser import HTMLParser
except ImportError:
    # Decky's frozen Windows Python bundles neither html.parser nor
    # _markupbase; _stdlib_compat holds unmodified CPython copies.
    sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_stdlib_compat"))
    from html_parser import HTMLParser

API = "https://gamebanana.com/apiv11"
CORE = "https://api.gamebanana.com"
SITE = "https://gamebanana.com"

GB_ID_BASE = 1_000_000_000
PER_PAGE = 24
CORE_BATCH = 20

# Our sort keys -> apiv11 _sSort values. "default" sends none.
SORTS = {
    "default": "",
    "new": "Generic_Newest",
    "updated": "Generic_LatestUpdated",
    "liked": "Generic_MostLiked",
    "downloaded": "Generic_MostDownloaded",
    "viewed": "Generic_MostViewed",
}

TTL_LIST = 600
TTL_MOD = 600
TTL_GAME = 86400

# Only these hosts are fetched from or handed to the downloader.
_FILE_HOSTS = ("gamebanana.com", "files.gamebanana.com")
_IMAGE_HOSTS = ("images.gamebanana.com", "gamebanana.com")


class GBError(Exception):
    """A GameBanana call that did not produce usable data. The message is
    written for the user."""


# ---- ids -----------------------------------------------------------------


def is_gb_id(value) -> bool:
    try:
        return int(value) >= GB_ID_BASE
    except (TypeError, ValueError):
        return False


def to_local(gb_id) -> int:
    return GB_ID_BASE + int(gb_id)


def from_local(local_id) -> int:
    n = int(local_id)
    return n - GB_ID_BASE if n >= GB_ID_BASE else n


# ---- small helpers -------------------------------------------------------


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ""


def _host_ok(url: str, hosts) -> bool:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(host == h or host.endswith("." + h) for h in hosts)


def download_url(gb_file_id, given: str = "") -> str:
    """The URL the downloader fetches: the one GameBanana gave, if it is
    theirs and https, else the site's /dl/ link for the file."""
    given = _str(given)
    if given.startswith("http://"):
        given = "https://" + given[len("http://"):]
    if given and _host_ok(given, _FILE_HOSTS):
        return given
    return f"{SITE}/dl/{int(gb_file_id)}"


def image_url(media) -> str:
    """The first preview image of a record, mid-sized when offered."""
    if not isinstance(media, dict):
        return ""
    for img in media.get("_aImages") or []:
        if not isinstance(img, dict):
            continue
        base = _str(img.get("_sBaseUrl"))
        name = _str(img.get("_sFile530")) or _str(img.get("_sFile220")) or _str(img.get("_sFile"))
        if base and name:
            url = f"{base.rstrip('/')}/{name}"
            if _host_ok(url, _IMAGE_HOSTS):
                return url
    return ""


def image_urls(media, limit: int = 12) -> list:
    out = []
    if not isinstance(media, dict):
        return out
    for img in media.get("_aImages") or []:
        if not isinstance(img, dict):
            continue
        base = _str(img.get("_sBaseUrl"))
        name = _str(img.get("_sFile")) or _str(img.get("_sFile530"))
        url = f"{base.rstrip('/')}/{name}" if base and name else ""
        if url and _host_ok(url, _IMAGE_HOSTS) and url not in out:
            out.append(url)
        if len(out) >= limit:
            break
    return out


def norm_name(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[™®©:'’\-–—!.,()\[\]/]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_game_ref(text: str) -> int:
    """A GameBanana game id from what a user typed: a plain id or a
    gamebanana.com/games/<id> link (any page under it). 0 if neither."""
    t = (text or "").strip()
    if re.fullmatch(r"\d{1,9}", t):
        return int(t)
    m = re.search(r"gamebanana\.com/(?:[a-z]+/)?games/(\d{1,9})", t, re.I)
    return int(m.group(1)) if m else 0


# ---- description: html -> readable text ----------------------------------


class _TextOut(HTMLParser):
    _BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
              "blockquote", "tr", "table", "hr", "section", "pre"}
    _SKIP = {"script", "style", "iframe", "object", "embed", "noscript", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list = []
        self.images: list = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "img":
            src = dict(attrs).get("src") or ""
            if src.startswith("//"):
                src = "https:" + src
            if _host_ok(src, _IMAGE_HOSTS) and src not in self.images:
                self.images.append(src)
            return
        if tag == "li":
            self.parts.append("\n• ")
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if not self.skip and tag in self._BLOCK and tag != "br":
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag not in self._SKIP:
            self.handle_starttag(tag, attrs)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(re.sub(r"[ \t\r\f\v]+", " ", data.replace("\n", " ")))


def html_to_text(markup: str, limit: int = 20000) -> tuple:
    """(text, image urls) from a mod page's HTML. Nothing of the markup
    survives but line breaks and list bullets; images come back as URLs on
    GameBanana's own image host, for the page to show as pictures."""
    p = _TextOut()
    try:
        p.feed(markup or "")
        p.close()
    except Exception:  # noqa: BLE001 - malformed markup still yields what was read
        pass
    text = "".join(p.parts)
    text = html.unescape(text)
    lines = [ln.strip() for ln in text.split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return text[:limit], p.images[:12]


# ---- record shapes -------------------------------------------------------


def _ts_text(ts: int) -> str:
    if not ts:
        return ""
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")


def mod_summary(rec: dict) -> dict:
    """One row of a list or search answer, in the shape the page shows."""
    if not isinstance(rec, dict):
        return {}
    gid = _int(rec.get("_idRow"))
    sub = rec.get("_aSubmitter") if isinstance(rec.get("_aSubmitter"), dict) else {}
    cat = rec.get("_aRootCategory") if isinstance(rec.get("_aRootCategory"), dict) else {}
    updated = _int(rec.get("_tsDateUpdated")) or _int(rec.get("_tsDateModified")) or _int(rec.get("_tsDateAdded"))
    return {
        "gb_id": gid,
        "mod_id": to_local(gid) if gid else 0,
        "name": _str(rec.get("_sName")) or f"Mod {gid}",
        "author": _str(sub.get("_sName")),
        "thumbnail": image_url(rec.get("_aPreviewMedia")),
        "likes": _int(rec.get("_nLikeCount")),
        "views": _int(rec.get("_nViewCount")),
        "downloads": _int(rec.get("_nDownloadCount")),
        "added": _int(rec.get("_tsDateAdded")),
        "updated": updated,
        "version": _str(rec.get("_sVersion")),
        "category": _str(cat.get("_sName")),
        "nsfw": bool(rec.get("_bIsNsfw")) or _str(rec.get("_sInitialVisibility")) == "hide",
        "has_files": rec.get("_bHasFiles") is not False,
        "url": f"{SITE}/mods/{gid}" if gid else "",
    }


def file_summary(f: dict) -> dict:
    """A downloadable file, with local ids so it can go straight to the
    install pipeline."""
    fid = _int(f.get("_idRow"))
    size = _int(f.get("_nFilesize"))
    md5 = _str(f.get("_sMd5Checksum")).lower()
    analysis = (_str(f.get("_sAnalysisResult")) or _str(f.get("_sAvResult"))).lower()
    return {
        "gb_file_id": fid,
        "file_id": to_local(fid) if fid else 0,
        "name": _str(f.get("_sFile")) or f"file-{fid}",
        "file_name": _str(f.get("_sFile")) or f"file-{fid}.zip",
        "description": _str(f.get("_sDescription")),
        "version": _str(f.get("_sVersion")),
        "size": size,
        "size_kb": (size + 1023) // 1024 if size else 0,
        "date": _int(f.get("_tsDateAdded")),
        "downloads": _int(f.get("_nDownloadCount")),
        "md5": md5 if re.fullmatch(r"[0-9a-f]{32}", md5) else "",
        "url": download_url(fid, _str(f.get("_sDownloadUrl"))) if fid else "",
        "has_exe": bool(f.get("_bContainsExe")),
        # "ok" when the scan passed, anything else is worth saying aloud.
        "scan": analysis if analysis and analysis not in ("ok", "clean", "file is clean") else "",
    }


def files_newest_first(files: list) -> list:
    out = [file_summary(f) for f in files or [] if isinstance(f, dict) and _int(f.get("_idRow"))]
    out.sort(key=lambda f: (-f["date"], -f["gb_file_id"]))
    return out


def mod_profile(rec: dict) -> dict:
    """A mod's page."""
    if not isinstance(rec, dict) or not _int(rec.get("_idRow")):
        raise GBError("GameBanana returned no mod")
    base = mod_summary(rec)
    text, inline = html_to_text(_str(rec.get("_sText")))
    images = image_urls(rec.get("_aPreviewMedia"))
    for u in inline:
        if u not in images:
            images.append(u)
    game = rec.get("_aGame") if isinstance(rec.get("_aGame"), dict) else {}
    cat = rec.get("_aCategory") if isinstance(rec.get("_aCategory"), dict) else {}
    reqs = []
    for r in rec.get("_aRequirements") or []:
        if isinstance(r, (list, tuple)) and r:
            reqs.append({"name": _str(r[0]), "url": _str(r[1]) if len(r) > 1 else ""})
    files = files_newest_first(rec.get("_aFiles") or [])
    base.update({
        "summary": _str(rec.get("_sDescription")),
        "text": text,
        "images": images[:12],
        "category": _str(cat.get("_sName")) or base["category"],
        "game_id": _int(game.get("_idRow")),
        "game_name": _str(game.get("_sName")),
        "files": files,
        "requirements": reqs,
        "external_only": not files and bool(rec.get("_aAlternateFileSources")),
        "withheld": bool(rec.get("_bIsWithheld") or rec.get("_bIsTrashed") or rec.get("_bIsPrivate")),
        "downloads": _int(rec.get("_nDownloadCount")) or sum(f["downloads"] for f in files),
    })
    if not base["version"]:
        base["version"] = next((f["version"] for f in files if f["version"]), "")
    return base


def core_files(entry) -> list:
    """The files out of one Core/Item/Data answer for ``Files().aFiles()``.

    The documented call answers values without keys unless asked, and the
    files come as a dict keyed by file id; tolerate a plain list, a keyed
    answer, and one level of wrapping, since a wrong guess here only means
    "no update known" rather than a broken page."""
    if isinstance(entry, dict):
        if "_idRow" in entry:
            return [entry]
        for key in ("Files().aFiles()", "files"):
            if key in entry:
                return core_files(entry[key])
        vals = list(entry.values())
        if vals and all(isinstance(v, dict) and "_idRow" in v for v in vals):
            return vals
        out = []
        for v in vals:
            if isinstance(v, (dict, list)):
                out.extend(core_files(v))
        return out
    if isinstance(entry, list):
        out = []
        for v in entry:
            out.extend(core_files(v))
        return out
    return []


# ---- updates -------------------------------------------------------------

_VERSIONISH = re.compile(r"(?:v(?:er(?:sion)?)?[ ._-]?)?\d+(?:[._-]\d+)*[a-z]?|\b(?:final|beta|alpha|hotfix|fix|update|new|latest)\b")


def file_stem(name: str) -> str:
    """A file name without its extension, version numbers and dates, so
    "Cool Skin v1.2.zip" and "Cool Skin v1.3.7z" are the same file."""
    base = re.sub(r"\.(zip|7z|rar|tar|gz|xz|bz2)$", "", (name or "").lower())
    base = _VERSIONISH.sub(" ", base)
    return re.sub(r"[\s._()\[\]-]+", " ", base).strip()


# A file uploaded this soon after the installed one is a sibling of the
# same upload (variant packs go up together), not a newer build of it.
SIBLING_WINDOW = 120


def update_for(record: dict, files: list) -> dict:
    """Whether an installed GameBanana file has a newer upload.

    ``record`` is the install record (local ids, plus ``gb_file_date`` when
    known); ``files`` is the mod's current list from ``files_newest_first``.
    The baseline is the installed file's upload date, else when it was
    installed. A newer file counts when it was uploaded after the baseline
    (by more than a sibling upload's few seconds); among several, one with
    the installed file's name stem is the successor. Returns
    {update_available, current, file}."""
    if not files:
        return {"update_available": False, "current": "", "file": None}
    inst_gb = from_local(record.get("file_id") or 0)
    mine = next((f for f in files if f["gb_file_id"] == inst_gb), None)
    baseline = (mine or {}).get("date") or _int(record.get("gb_file_date")) or _int(record.get("installed_at"))
    newer = [f for f in files if f["gb_file_id"] != inst_gb and f["date"] > baseline + SIBLING_WINDOW]
    if not newer:
        cur = mine or files[0]
        return {"update_available": False, "current": cur["version"] or _ts_text(cur["date"]), "file": None}
    stem = file_stem(record.get("file_name") or (mine or {}).get("file_name") or "")
    same = [f for f in newer if stem and file_stem(f["file_name"]) == stem]
    pick = (same or newer)[0]
    if mine and stem and not same:
        # The installed file is still up and the newer upload looks like a
        # different file of the mod (another variant, an add-on): that is
        # not this file's update.
        return {"update_available": False, "current": mine["version"] or _ts_text(mine["date"]), "file": None}
    return {"update_available": True, "current": pick["version"] or f"{pick['name']} ({_ts_text(pick['date'])})",
            "file": pick}


# ---- the client ----------------------------------------------------------


class Client:
    """GameBanana reads with caching, a small concurrency cap and retries.

    ``transport(url)`` is an async callable returning ``(status, text)``.
    """

    def __init__(self, transport, clock=time.monotonic, sleep=asyncio.sleep, concurrency: int = 4):
        self._transport = transport
        self._clock = clock
        self._sleep = sleep
        self._cache: dict = {}
        self._sem = None
        self._concurrency = concurrency
        # Download link and checksum of every file seen, for the downloader.
        self.file_info: dict = {}

    # -- plumbing

    def _cached(self, key):
        hit = self._cache.get(key)
        if hit and hit[0] > self._clock():
            return hit[1]
        return None

    def _store(self, key, value, ttl):
        if len(self._cache) > 500:
            now = self._clock()
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
        self._cache[key] = (self._clock() + ttl, value)
        return value

    def clear(self):
        self._cache.clear()

    async def get_json(self, url: str):
        if self._sem is None:
            self._sem = asyncio.Semaphore(self._concurrency)
        last = "GameBanana did not answer"
        for attempt in range(3):
            if attempt:
                await self._sleep(1.5 * attempt)
            async with self._sem:
                try:
                    status, text = await self._transport(url)
                except asyncio.TimeoutError:
                    last = "GameBanana timed out"
                    continue
                except GBError:
                    raise
                except Exception as e:  # noqa: BLE001 - transport errors become a message
                    last = f"Network error: {type(e).__name__}"
                    continue
            if status in (429, 500, 502, 503, 504):
                last = f"GameBanana is busy (HTTP {status})"
                continue
            if status == 404:
                raise GBError("Not found on GameBanana")
            if status != 200:
                raise GBError(f"GameBanana error (HTTP {status})")
            body = (text or "").lstrip()
            if body[:1] not in ("{", "["):
                # Cloudflare's checks and maintenance pages come back 200.
                last = "GameBanana answered with a web page instead of data"
                continue
            try:
                data = json.loads(body)
            except ValueError:
                raise GBError("GameBanana sent data that could not be read") from None
            if isinstance(data, dict) and (data.get("_sErrorCode") or data.get("error")) and "_idRow" not in data:
                raise GBError(_str(data.get("_sErrorMessage")) or _str(data.get("error"))
                              or f"GameBanana error ({data.get('_sErrorCode')})")
            return data
        raise GBError(last)

    def _remember_files(self, files: list):
        for f in files:
            if f.get("gb_file_id"):
                self.file_info[f["gb_file_id"]] = {"url": f["url"], "md5": f["md5"], "size": f["size"],
                                                   "date": f["date"], "name": f["file_name"]}

    # -- games

    async def match_games(self, name: str) -> list:
        """[{id, name, icon}] for games whose name matches."""
        q = (name or "").strip()
        if len(q) < 2:
            return []
        key = ("games", q.lower())
        hit = self._cached(key)
        if hit is not None:
            return hit
        data = await self.get_json(f"{API}/Util/Game/NameMatch?_sName={urllib.parse.quote(q)}&_nPerpage=15")
        recs = data.get("_aRecords") if isinstance(data, dict) else data
        out = []
        for r in recs or []:
            if isinstance(r, dict) and _int(r.get("_idRow")):
                out.append({"id": _int(r.get("_idRow")), "name": _str(r.get("_sName")),
                            "icon": _str(r.get("_sIconUrl"))})
        return self._store(key, out, TTL_GAME)

    async def game_name(self, game_id: int) -> str:
        """A game's name by id ('' when there is no such game)."""
        key = ("gname", int(game_id))
        hit = self._cached(key)
        if hit is not None:
            return hit
        url = f"{CORE}/Core/Item/Data?itemtype=Game&itemid={int(game_id)}&fields=name&return_keys=1&format=json_min"
        data = await self.get_json(url)
        name = ""
        if isinstance(data, dict):
            name = _str(data.get("name"))
        elif isinstance(data, list) and data:
            name = _str(data[0]) if not isinstance(data[0], dict) else _str(data[0].get("name"))
        return self._store(key, name, TTL_GAME)

    # -- lists

    async def list_mods(self, game_id: int, page: int = 1, sort: str = "default", search: str = "",
                        per_page: int = PER_PAGE) -> dict:
        """{mods, page, total, has_more, sort_fallback}."""
        page = max(1, int(page))
        search = (search or "").strip()
        key = ("list", int(game_id), page, sort, search.lower(), per_page)
        hit = self._cached(key)
        if hit is not None:
            return hit
        fallback = False
        if search:
            url = (f"{API}/Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow={int(game_id)}"
                   f"&_sSearchString={urllib.parse.quote(search)}&_nPage={page}&_nPerpage={per_page}")
            data = await self.get_json(url)
        else:
            base = (f"{API}/Mod/Index?_nPage={page}&_nPerpage={per_page}"
                    f"&_aFilters%5BGeneric_Game%5D={int(game_id)}")
            api_sort = SORTS.get(sort, "")
            data = None
            if api_sort:
                try:
                    data = await self.get_json(f"{base}&_sSort={api_sort}")
                except GBError:
                    # The sort names are not documented: one the server
                    # does not take shows its default order, said so on the
                    # page, rather than no mods at all.
                    fallback = True
            if data is None:
                data = await self.get_json(base)
        meta = data.get("_aMetadata") if isinstance(data, dict) else {}
        recs = data.get("_aRecords") if isinstance(data, dict) else data
        mods = [mod_summary(r) for r in recs or [] if isinstance(r, dict)
                and (not r.get("_sModelName") or r.get("_sModelName") == "Mod")]
        mods = [m for m in mods if m.get("gb_id")]
        total = _int((meta or {}).get("_nRecordCount"), len(mods))
        complete = (meta or {}).get("_bIsComplete")
        has_more = (not complete) if isinstance(complete, bool) else page * per_page < total
        out = {"mods": mods, "page": page, "total": total, "has_more": bool(has_more) and bool(recs),
               "sort_fallback": fallback}
        return self._store(key, out, TTL_LIST)

    # -- one mod

    async def mod(self, gb_mod_id: int, fresh: bool = False) -> dict:
        key = ("mod", int(gb_mod_id))
        hit = None if fresh else self._cached(key)
        if hit is not None:
            return hit
        data = await self.get_json(f"{API}/Mod/{int(gb_mod_id)}/ProfilePage")
        prof = mod_profile(data)
        self._remember_files(prof["files"])
        return self._store(key, prof, TTL_MOD)

    async def files_for(self, gb_mod_ids: list) -> dict:
        """{gb mod id: files newest first} for many mods: the documented
        Core multicall, 20 a request; mods it does not answer for are read
        from their pages instead."""
        ids = [int(i) for i in dict.fromkeys(gb_mod_ids or [])]
        out: dict = {}
        for start in range(0, len(ids), CORE_BATCH):
            chunk = ids[start:start + CORE_BATCH]
            q = "&".join(f"itemtype[]=Mod&itemid[]={i}&fields[]=Files().aFiles()" for i in chunk)
            try:
                data = await self.get_json(f"{CORE}/Core/Item/Data?{q}&format=json_min")
            except GBError:
                data = None
            if isinstance(data, list) and len(data) == len(chunk):
                for i, entry in zip(chunk, data):
                    files = files_newest_first(core_files(entry))
                    if files:
                        self._remember_files(files)
                        out[i] = files
        missing = [i for i in ids if i not in out]

        async def one(i):
            try:
                out[i] = (await self.mod(i, fresh=True))["files"]
            except GBError:
                pass
        await asyncio.gather(*(one(i) for i in missing))
        return out

    async def file_download(self, gb_file_id: int) -> dict:
        """{url, md5, size} for a file, from what has been seen; a file
        never seen gets its /dl/ link and no checksum."""
        info = self.file_info.get(int(gb_file_id))
        if info:
            return info
        return {"url": download_url(gb_file_id), "md5": "", "size": 0, "date": 0, "name": ""}


def looks_like_html(head: bytes) -> bool:
    h = (head or b"")[:512].lstrip().lower()
    return h.startswith(b"<!doctype html") or h.startswith(b"<html") or b"<head" in h[:200]


def best_game_match(steam_name: str, candidates: list):
    """The candidate whose name is the Steam game's name, or None."""
    want = norm_name(steam_name)
    if not want:
        return None
    for c in candidates or []:
        if norm_name(c.get("name") or "") == want:
            return c
    return None
