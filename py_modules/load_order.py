"""Forge: load-order sorting with LOOT's masterlist rules, and deploy profiles,
for the Bethesda games whose load order is a text file.

Pure functions only (no Decky, no network): main.py does the paths, the
download, the callables and the anti-cheat / save-backup wrappers. Tested by
tests/test_load_order.py.

Written from public documentation, not from any program's code:
- the masterlist format and condition syntax from LOOT's metadata docs
  (https://loot-api.readthedocs.io/en/latest/metadata/);
- the per-game files (plugins.txt / loadorder.txt, the asterisk and text-file
  methods, the hardcoded plugins, Oblivion Remastered's Data folder) from
  libloadorder's documentation and changelog;
- the plugin header (TES4 record, MAST subrecords, flags) from UESP's file
  format pages.
The masterlists themselves are downloaded by the user's PC at run time from
https://github.com/loot (CC0 for Skyrim SE, Fallout 4, Starfield and Oblivion
Remastered) and are never shipped with Forge.

What it does NOT do, on purpose (a compact sort, not LOOT): no record-overlap
edges (LOOT reads every record to put the plugin that overrides more first),
no Bash Tags, no userlist, no CRC of very large files without zlib, and
conditions it cannot evaluate (version(), product_version(), ...) count as
"unknown", which hides the message or skips the rule rather than guessing.
"""

import heapq
import os
import re
import struct

# ---- the games ----------------------------------------------------------------
# method: "asterisk" = plugins.txt lists every plugin in load order, '*' marks
# the active ones (Skyrim SE, Fallout 4, Starfield). "textfile" = plugins.txt
# lists only the active plugins, in order, and loadorder.txt beside it lists
# all of them (Oblivion Remastered, whose plugins.txt lives in its Data folder).

GAMES = {
    "skyrimspecialedition": {
        "name": "Skyrim Special Edition",
        "app_ids": (489830,),
        "masterlist": "skyrimse",
        "method": "asterisk",
        "local": "Skyrim Special Edition",
        "data": "Data",
        "header": 24,
        "light_flag": 0x200,
        "medium_flag": 0,
        "blueprint_flag": 0,
        "ext_master": True,
        "implicit": ("Skyrim.esm", "Update.esm", "Dawnguard.esm", "HearthFires.esm",
                     "Dragonborn.esm"),
        "exes": ("SkyrimSE.exe",),
        "cleaner": "SSEEdit",
    },
    "fallout4": {
        "name": "Fallout 4",
        "app_ids": (377160,),
        "masterlist": "fallout4",
        "method": "asterisk",
        "local": "Fallout4",
        "data": "Data",
        "header": 24,
        "light_flag": 0x200,
        "medium_flag": 0,
        "blueprint_flag": 0,
        "ext_master": True,
        "implicit": ("Fallout4.esm", "DLCRobot.esm", "DLCworkshop01.esm", "DLCCoast.esm",
                     "DLCworkshop02.esm", "DLCworkshop03.esm", "DLCNukaWorld.esm",
                     "DLCUltraHighResolution.esm"),
        "exes": ("Fallout4.exe",),
        "cleaner": "FO4Edit",
    },
    "starfield": {
        "name": "Starfield",
        "app_ids": (1716740,),
        "masterlist": "starfield",
        "method": "asterisk",
        "local": "Starfield",
        "data": "Data",
        "header": 24,
        # Starfield moved the light ("small") flag and added medium plugins
        # and blueprint masters.
        "light_flag": 0x100,
        "medium_flag": 0x400,
        "blueprint_flag": 0x800,
        "ext_master": True,
        "implicit": ("Starfield.esm", "Constellation.esm", "OldMars.esm", "ShatteredSpace.esm",
                     "SFBGS003.esm", "SFBGS004.esm", "SFBGS006.esm", "SFBGS007.esm",
                     "SFBGS008.esm", "SFBGS00D.esm", "SFBGS047.esm", "SFBGS050.esm"),
        "exes": ("Starfield.exe",),
        "cleaner": "SF1Edit",
    },
    "oblivionremastered": {
        "name": "Oblivion Remastered",
        "app_ids": (2623190,),
        "masterlist": "oblivion-remastered",
        "method": "textfile",
        "local": "",
        "data": "OblivionRemastered/Content/Dev/ObvData/Data",
        # Oblivion's record header is 20 bytes, not 24.
        "header": 20,
        "light_flag": 0,
        "medium_flag": 0,
        "blueprint_flag": 0,
        # Oblivion decides "master" by the header flag alone.
        "ext_master": False,
        "implicit": (),
        "exes": ("OblivionRemastered-Win64-Shipping.exe", "OblivionRemastered.exe"),
        "cleaner": "xEdit",
    },
}

MASTERLIST_BRANCHES = ("v0.26", "master")
MASTERLIST_URL = "https://raw.githubusercontent.com/loot/{repo}/{branch}/masterlist.yaml"
MASTERLIST_PREFIX = "https://raw.githubusercontent.com/loot/"
MASTERLIST_MAX_BYTES = 8 << 20
REFRESH_SECONDS = 24 * 3600
RETRY_SECONDS = 3600

PLUGIN_EXTS = (".esm", ".esp", ".esl")
FLAG_MASTER = 0x1


def game_for(app_id=0, domain=""):
    """(key, game) for a supported game, by Steam app id first, then by the
    Nexus domain. (None, None) for everything else."""
    try:
        app_id = int(app_id or 0)
    except (TypeError, ValueError):
        app_id = 0
    for key, g in GAMES.items():
        if app_id and app_id in g["app_ids"]:
            return key, g
    if domain in GAMES:
        return domain, GAMES[domain]
    return None, None


def is_plugin_name(name):
    return isinstance(name, str) and name.lower().endswith(PLUGIN_EXTS)


# ---- plugin headers -----------------------------------------------------------

def parse_header(data, game):
    """From the first bytes of a plugin: {"flags", "masters", "master",
    "light", "medium", "blueprint"} or None when it is not a plugin.

    The TES4 record: type, data size, flags, then (after the rest of the
    20- or 24-byte record header) subrecords of 4-char type + uint16 size.
    An XXXX subrecord carries a uint32 size for the one after it."""
    hs = game["header"]
    if len(data) < hs or data[:4] != b"TES4":
        return None
    size = struct.unpack_from("<I", data, 4)[0]
    flags = struct.unpack_from("<I", data, 8)[0]
    body = data[hs:hs + size]
    masters, off, big = [], 0, None
    while off + 6 <= len(body):
        sub = body[off:off + 4]
        ln = struct.unpack_from("<H", body, off + 4)[0]
        if big is not None:
            ln, big = big, None
        if sub == b"XXXX" and ln == 4 and off + 10 <= len(body):
            big = struct.unpack_from("<I", body, off + 6)[0]
            off += 10
            continue
        if sub == b"MAST" and ln:
            masters.append(body[off + 6:off + 6 + ln].split(b"\x00", 1)[0].decode("cp1252", "replace"))
        off += 6 + ln
    return {"flags": flags, "masters": masters, **plugin_kind("", flags, game)}


def plugin_kind(name, flags, game):
    low = (name or "").lower()
    light = bool(game["light_flag"] and flags & game["light_flag"]) or (
        bool(game["light_flag"]) and low.endswith(".esl"))
    master = bool(flags & FLAG_MASTER) or (game["ext_master"] and low.endswith((".esm", ".esl")))
    return {
        "master": master,
        "light": light,
        "medium": bool(game["medium_flag"] and flags & game["medium_flag"]) and not light,
        "blueprint": bool(game["blueprint_flag"] and flags & game["blueprint_flag"]) and master,
    }


def read_header(path, game):
    """parse_header for a file on disk; None when unreadable or not a plugin."""
    try:
        with open(path, "rb") as f:
            head = f.read(game["header"])
            if len(head) < game["header"] or head[:4] != b"TES4":
                return None
            size = struct.unpack_from("<I", head, 4)[0]
            rest = f.read(min(size, 1 << 20))
    except OSError:
        return None
    info = parse_header(head + rest, game)
    if info is not None:
        info.update(plugin_kind(os.path.basename(path), info["flags"], game))
    return info


# ---- a YAML subset (what LOOT's masterlists use) ---------------------------------
# Block mappings and sequences, anchors (&x), aliases (*x), merge keys (<<),
# plain / single- / double-quoted scalars (multi-line too), flow sequences and
# mappings ([..], {..}), comments, literal and folded block scalars. Not a
# general YAML parser: no tags, no complex keys, no multiple documents.

class YamlError(ValueError):
    pass


_INT = re.compile(r"[-+]?(0x[0-9a-fA-F]+|0o[0-7]+|[0-9]+)$")


def _plain_value(s):
    t = s.strip()
    if t in ("", "~", "null", "Null", "NULL"):
        return None
    if t in ("true", "True", "TRUE"):
        return True
    if t in ("false", "False", "FALSE"):
        return False
    if _INT.match(t):
        try:
            return int(t, 0)
        except ValueError:
            return t
    return t


def _strip_comment(s):
    """The line without a trailing comment (a '#' at the start or after a
    space, outside quotes)."""
    q = None
    i = 0
    while i < len(s):
        c = s[i]
        if q == "'":
            if c == "'":
                if i + 1 < len(s) and s[i + 1] == "'":
                    i += 1
                else:
                    q = None
        elif q == '"':
            if c == "\\":
                i += 1
            elif c == '"':
                q = None
        elif c in "'\"" and (i == 0 or s[i - 1] in " \t[{,:-"):
            q = c
        elif c == "#" and (i == 0 or s[i - 1] in " \t"):
            return s[:i].rstrip()
        i += 1
    return s.rstrip()


_DQ_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", '"': '"', "/": "/",
           " ": " ", "e": "\x1b", "a": "\a", "b": "\b", "f": "\f", "v": "\v"}


def _scan_quoted(s, i):
    """A quoted scalar starting at s[i]: (text, index after it), or
    (text so far, None) when the line ends inside it."""
    q = s[i]
    out = []
    j = i + 1
    while j < len(s):
        c = s[j]
        if q == "'":
            if c == "'":
                if j + 1 < len(s) and s[j + 1] == "'":
                    out.append("'")
                    j += 2
                    continue
                return "".join(out), j + 1
            out.append(c)
        else:
            if c == "\\":
                if j + 1 >= len(s):
                    out.append("\\")
                    return "".join(out), None
                n = s[j + 1]
                if n == "x" and j + 3 < len(s):
                    out.append(chr(int(s[j + 2:j + 4], 16)))
                    j += 4
                    continue
                if n == "u" and j + 5 < len(s):
                    out.append(chr(int(s[j + 2:j + 6], 16)))
                    j += 6
                    continue
                out.append(_DQ_ESC.get(n, n))
                j += 2
                continue
            if c == '"':
                return "".join(out), j + 1
            out.append(c)
        j += 1
    return "".join(out), None


class _Parser:
    def __init__(self, text):
        self.lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if self.lines and self.lines[0].startswith("﻿"):
            self.lines[0] = self.lines[0][1:]
        self.i = 0
        self.anchors = {}

    # -- lines --
    def _skip(self):
        while self.i < len(self.lines):
            s = self.lines[self.i]
            st = s.strip()
            if st and not st.startswith("#") and st not in ("---", "..."):
                if "\t" in s[:len(s) - len(s.lstrip())]:
                    raise YamlError(f"tab indentation on line {self.i + 1}")
                return True
            self.i += 1
        return False

    def _indent(self):
        s = self.lines[self.i]
        return len(s) - len(s.lstrip(" "))

    # -- structure --
    def node(self, min_indent):
        if not self._skip():
            return None
        ind = self._indent()
        if ind < min_indent:
            return None
        content = self.lines[self.i][ind:]
        if content == "-" or content.startswith("- "):
            return self.seq(ind)
        if self._key(content) is not None:
            return self.mapping(ind)
        return self.scalar_lines(ind, content, ind - 1)

    def _key(self, content):
        """(key, rest) when the line is 'key: value' / 'key:'; else None."""
        if content[:1] in ("'", '"'):
            text, end = _scan_quoted(content, 0)
            if end is None:
                return None
            rest = content[end:]
            if rest.startswith(":") and (len(rest) == 1 or rest[1] in " \t"):
                return text, rest[1:].strip()
            return None
        if content[:1] in ("[", "{", "&", "*", "|", ">", "!", "%", "@", "`"):
            return None
        j = 0
        while True:
            j = content.find(":", j)
            if j < 0:
                return None
            if j + 1 == len(content) or content[j + 1] in " \t":
                key = content[:j].strip()
                if "#" in key and _strip_comment(key) != key:
                    return None
                return key, content[j + 1:].strip()
            j += 1

    def seq(self, ind):
        out = []
        while self._skip() and self._indent() == ind:
            line = self.lines[self.i]
            content = line[ind:]
            if not (content == "-" or content.startswith("- ")):
                break
            rest = content[1:]
            stripped = rest.lstrip(" ")
            inner = ind + 1 + (len(rest) - len(stripped))
            stripped_nc = _strip_comment(stripped)
            if not stripped_nc:
                self.i += 1
                out.append(self.node(ind + 1))
                continue
            anchor = None
            if stripped_nc.startswith("&"):
                parts = stripped_nc.split(None, 1)
                anchor = parts[0][1:]
                if len(parts) == 1:
                    self.i += 1
                    val = self.node(ind + 1)
                    self.anchors[anchor] = val
                    out.append(val)
                    continue
                stripped = stripped[stripped.index(parts[1]):]
                inner = len(line) - len(stripped)
                stripped_nc = _strip_comment(stripped)
            if stripped_nc.startswith("- ") or stripped_nc == "-" or self._key(stripped) is not None:
                # A mapping or a sequence opened on the dash's line: re-read
                # the line as if the dash were a space.
                self.lines[self.i] = " " * inner + stripped
                val = self.node(inner)
            else:
                val = self.value(stripped, ind)
            if anchor:
                self.anchors[anchor] = val
            out.append(val)
        return out

    def mapping(self, ind):
        explicit, merges = {}, []
        while self._skip() and self._indent() == ind:
            content = self.lines[self.i][ind:]
            if content == "-" or content.startswith("- "):
                break
            kv = self._key(content)
            if kv is None:
                raise YamlError(f"expected a key on line {self.i + 1}")
            key, rest = kv
            rest_nc = _strip_comment(rest)
            if not rest_nc:
                self.i += 1
                # A sequence may sit at the key's own indent.
                if self._skip() and self._indent() == ind and (
                        self.lines[self.i][ind:] == "-" or self.lines[self.i][ind:].startswith("- ")):
                    val = self.seq(ind)
                else:
                    val = self.node(ind + 1)
            else:
                val = self.value(rest, ind)
            if key == "<<":
                merges.extend(val if isinstance(val, list) else [val])
            else:
                explicit[key] = val
        out = {}
        for m in reversed(merges):
            if isinstance(m, dict):
                out.update(m)
        out.update(explicit)
        return out

    # -- values --
    def value(self, rest, parent_indent):
        """A value that starts on the current line after 'key:' or '- '."""
        s = rest.lstrip()
        if s.startswith("&"):
            parts = s.split(None, 1)
            name = parts[0][1:]
            remainder = parts[1] if len(parts) > 1 else ""
            if not _strip_comment(remainder):
                self.i += 1
                if self._skip() and self._indent() == parent_indent and (
                        self.lines[self.i][parent_indent:].startswith("- ")):
                    val = self.seq(parent_indent)
                else:
                    val = self.node(parent_indent + 1)
            else:
                val = self.value(remainder, parent_indent)
            self.anchors[name] = val
            return val
        if s.startswith("*"):
            self.i += 1
            name = _strip_comment(s)[1:].strip()
            return self.anchors.get(name)
        if s[:1] in ("[", "{"):
            return self.flow_lines(s)
        if s[:1] in ("|", ">"):
            return self.block_scalar(s, parent_indent)
        return self.scalar_lines(parent_indent, s, parent_indent)

    def scalar_lines(self, ind, s, parent_indent):
        if s[:1] in ("'", '"'):
            text, end = _scan_quoted(s, 0)
            parts = [text]
            while end is None:
                self.i += 1
                if self.i >= len(self.lines):
                    raise YamlError("unterminated quoted scalar")
                nxt = self.lines[self.i].strip()
                if not nxt:
                    parts.append("\n")
                    continue
                text, end = _scan_quoted(s[0] + nxt, 0)
                parts.append(text)
            self.i += 1
            return _fold(parts)
        parts = [_strip_comment(s)]
        self.i += 1
        # A plain scalar continues on more-indented lines.
        while self.i < len(self.lines):
            nxt = self.lines[self.i]
            st = nxt.strip()
            if not st:
                break
            if len(nxt) - len(nxt.lstrip(" ")) <= parent_indent or st.startswith("#"):
                break
            parts.append(_strip_comment(st))
            self.i += 1
        return _plain_value(" ".join(p for p in parts if p))

    def block_scalar(self, head, parent_indent):
        head = _strip_comment(head)
        folded = head.startswith(">")
        chomp = "-" if "-" in head else "+" if "+" in head else ""
        self.i += 1
        body, ind = [], None
        while self.i < len(self.lines):
            line = self.lines[self.i]
            if line.strip():
                cur = len(line) - len(line.lstrip(" "))
                if cur <= parent_indent:
                    break
                ind = cur if ind is None else ind
                body.append(line[ind:])
            else:
                body.append("")
            self.i += 1
        trailing = 0
        while body and not body[-1]:
            body.pop()
            trailing += 1
        if folded:
            out, prev = "", None
            for line in body:
                if not line:
                    out += "\n"
                    prev = "e"
                    continue
                kind = "m" if line[:1] in (" ", "\t") else "n"
                if prev is None or prev == "e":
                    out += line
                elif prev == "n" and kind == "n":
                    out += " " + line
                else:
                    out += "\n" + line
                prev = kind
        else:
            out = "\n".join(body)
        if chomp == "-" or not body:
            return out
        return out + "\n" + ("\n" * trailing if chomp == "+" else "")

    def flow_lines(self, s):
        text = _strip_comment(s)
        depth = _flow_depth(text)
        while depth > 0:
            self.i += 1
            if self.i >= len(self.lines):
                raise YamlError("unterminated flow collection")
            more = _strip_comment(self.lines[self.i].strip())
            text += " " + more
            depth = _flow_depth(text)
        self.i += 1
        val, _ = self.flow(text, 0)
        return val

    def flow(self, s, i):
        while i < len(s) and s[i] in " \t":
            i += 1
        if i >= len(s):
            return None, i
        c = s[i]
        if c == "[":
            out, i = [], i + 1
            while True:
                while i < len(s) and s[i] in " \t,":
                    i += 1
                if i >= len(s):
                    raise YamlError("unterminated [")
                if s[i] == "]":
                    return out, i + 1
                v, i = self.flow(s, i)
                out.append(v)
        if c == "{":
            out, i = {}, i + 1
            while True:
                while i < len(s) and s[i] in " \t,":
                    i += 1
                if i >= len(s):
                    raise YamlError("unterminated {")
                if s[i] == "}":
                    return out, i + 1
                k, i = self.flow(s, i)
                while i < len(s) and s[i] in " \t":
                    i += 1
                v = None
                if i < len(s) and s[i] == ":":
                    v, i = self.flow(s, i + 1)
                if k == "<<" and isinstance(v, dict):
                    for kk, vv in v.items():
                        out.setdefault(kk, vv)
                else:
                    out[k] = v
        if c in ("'", '"'):
            text, end = _scan_quoted(s, i)
            if end is None:
                raise YamlError("unterminated quoted scalar in flow")
            return text, end
        if c == "*":
            j = i + 1
            while j < len(s) and s[j] not in ",]} \t":
                j += 1
            return self.anchors.get(s[i + 1:j]), j
        if c == "&":
            j = i + 1
            while j < len(s) and s[j] not in " \t":
                j += 1
            v, k = self.flow(s, j)
            self.anchors[s[i + 1:j]] = v
            return v, k
        j = i
        while j < len(s) and s[j] not in ",]}":
            if s[j] == ":" and (j + 1 >= len(s) or s[j + 1] in " \t,]}"):
                break
            j += 1
        return _plain_value(s[i:j]), j


def _flow_depth(text):
    depth, q, i = 0, None, 0
    while i < len(text):
        c = text[i]
        if q == "'":
            if c == "'":
                if i + 1 < len(text) and text[i + 1] == "'":
                    i += 1
                else:
                    q = None
        elif q == '"':
            if c == "\\":
                i += 1
            elif c == '"':
                q = None
        elif c in "'\"":
            q = c
        elif c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
        i += 1
    return depth if q is None else max(depth, 1)


def _fold(parts):
    out = ""
    for k, p in enumerate(parts):
        if k == 0:
            out = p.rstrip(" ") if len(parts) > 1 else p
        elif p == "\n":
            out += "\n"
        else:
            if out and not out.endswith("\n"):
                out += " "
            out += p.lstrip(" ") if k == len(parts) - 1 else p.strip(" ")
    return out


def parse_yaml(text):
    p = _Parser(text)
    return p.node(0)


# ---- the masterlist -----------------------------------------------------------

_REGEX_CHARS = set(":\\*?|")


def _file_entry(x):
    if isinstance(x, str):
        return {"name": x}
    if isinstance(x, dict) and isinstance(x.get("name"), str):
        out = {"name": x["name"]}
        if isinstance(x.get("display"), str):
            out["display"] = x["display"]
        if isinstance(x.get("condition"), str):
            out["condition"] = x["condition"]
        return out
    return None


def _message_text(content, subs):
    if isinstance(content, list):
        pick = next((c for c in content if isinstance(c, dict) and c.get("lang") in ("en", "en_US")), None)
        pick = pick or next((c for c in content if isinstance(c, dict)), None)
        content = (pick or {}).get("text", "")
    text = str(content or "")
    for n, sub in enumerate(subs or []):
        text = text.replace("{%d}" % n, str(sub))
    return plain_text(text)


def plain_text(text):
    """Markdown to the plain text a TV row can show."""
    text = re.sub(r"\[([^\]]*)\]\(([^)]*)\)", lambda m: m.group(1) or m.group(2), text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def _message(m):
    if not isinstance(m, dict):
        return None
    kind = str(m.get("type") or "say").lower()
    subs = m.get("subs") if isinstance(m.get("subs"), list) else []
    out = {"type": kind if kind in ("say", "warn", "error") else "say",
           "text": _message_text(m.get("content"), subs)}
    if isinstance(m.get("condition"), str):
        out["condition"] = m["condition"]
    return out if out["text"] else None


def _dirty(d):
    if not isinstance(d, dict) or not isinstance(d.get("crc"), int):
        return None
    out = {"crc": d["crc"] & 0xFFFFFFFF, "util": plain_text(str(d.get("util") or ""))}
    for k in ("itm", "udr", "nav"):
        if isinstance(d.get(k), int):
            out[k] = d[k]
    return out


def reduce_masterlist(doc):
    """The parts of a parsed masterlist the sorter and the warnings use, as
    plain JSON (cached on disk so the YAML is parsed once a day at most)."""
    if not isinstance(doc, dict) or not isinstance(doc.get("plugins"), list):
        raise YamlError("not a LOOT masterlist (no plugins list)")
    groups = {}
    for g in doc.get("groups") or []:
        if isinstance(g, dict) and isinstance(g.get("name"), str):
            groups[g["name"]] = [a for a in (g.get("after") or []) if isinstance(a, str)]
    groups.setdefault("default", [])
    plugins = []
    for p in doc["plugins"]:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        e = {"name": p["name"]}
        if isinstance(p.get("group"), str):
            e["group"] = p["group"]
        for key in ("after", "req", "inc"):
            files = [f for f in (_file_entry(x) for x in (p.get(key) or [])) if f]
            if files:
                e[key] = files
        msgs = [m for m in (_message(x) for x in (p.get("msg") or [])) if m]
        if msgs:
            e["msg"] = msgs
        dirty = [d for d in (_dirty(x) for x in (p.get("dirty") or [])) if d]
        if dirty:
            e["dirty"] = dirty
        if len(e) > 1:
            plugins.append(e)
    globals_ = [m for m in (_message(x) for x in (doc.get("globals") or [])) if m]
    return {"groups": groups, "plugins": plugins, "globals": globals_}


def _is_regex(name):
    return any(c in _REGEX_CHARS for c in name)


class Masterlist:
    """Lookups over a reduced masterlist. Exact names win over regex
    entries; every entry that matches adds its rules."""

    def __init__(self, reduced=None):
        reduced = reduced or {"groups": {"default": []}, "plugins": [], "globals": []}
        self.groups = dict(reduced.get("groups") or {})
        self.groups.setdefault("default", [])
        self.globals = list(reduced.get("globals") or [])
        self.exact, self.regex = {}, []
        for e in reduced.get("plugins") or []:
            name = e.get("name") or ""
            if _is_regex(name):
                try:
                    self.regex.append((re.compile(name, re.IGNORECASE), e))
                except re.error:
                    continue
            else:
                self.exact.setdefault(name.lower(), e)
        self._ancestors = None
        self.group_cycle = []

    def lookup(self, name):
        low = name.lower()
        found = []
        if low in self.exact:
            found.append(self.exact[low])
        for rx, e in self.regex:
            if rx.fullmatch(name):
                found.append(e)
        meta = {"group": None, "after": [], "req": [], "inc": [], "msg": [], "dirty": []}
        for e in found:
            if meta["group"] is None and e.get("group"):
                meta["group"] = e["group"]
            for key in ("after", "req", "inc", "msg", "dirty"):
                meta[key].extend(e.get(key) or [])
        if meta["group"] not in self.groups:
            meta["group"] = "default"
        return meta

    def ancestors(self):
        """group -> every group it loads after, transitively. A cycle in the
        groups is reported and those groups are ignored."""
        if self._ancestors is not None:
            return self._ancestors
        out, state, cycle = {}, {}, []

        def visit(g, path):
            if state.get(g) == 2:
                return out.get(g, set())
            if state.get(g) == 1:
                cycle.extend(path[path.index(g):] if g in path else [g])
                return set()
            state[g] = 1
            acc = set()
            for a in self.groups.get(g, []):
                if a in self.groups:
                    acc.add(a)
                    acc |= visit(a, path + [g])
            state[g] = 2
            out[g] = acc
            return acc

        for g in list(self.groups):
            visit(g, [])
        if cycle:
            self.group_cycle = sorted(set(cycle))
            out = {g: set() for g in self.groups}
        self._ancestors = out
        return out


# ---- conditions ---------------------------------------------------------------
# True / False / None (cannot tell). and/or/not follow three-valued logic, so
# an unknown part only matters when it could change the answer.

_TOKEN = re.compile(r'\s*(?:(?P<str>"(?:[^"\\]|\\.)*")|(?P<op>\(|\)|,)|(?P<word>[^\s(),"]+))')


def _tokens(expr):
    out, i = [], 0
    while i < len(expr):
        m = _TOKEN.match(expr, i)
        if not m or m.end() == i:
            if expr[i:].strip():
                raise ValueError("bad condition")
            break
        i = m.end()
        if m.group("str") is not None:
            out.append(("str", m.group("str")[1:-1]))
        elif m.group("op"):
            out.append(("op", m.group("op")))
        elif m.group("word"):
            out.append(("word", m.group("word")))
    return out


class ConditionContext:
    """What a condition can ask about. files(rel) -> bool; crc(rel) -> int or
    None; active: set of lower-case active plugin names; plugins: lower name
    -> {"master": bool}; listdir(rel_dir) -> names."""

    def __init__(self, data_dir="", game_dir="", active=(), plugins=None, crc=None):
        self.data_dir = data_dir
        self.game_dir = game_dir or (os.path.dirname(data_dir) if data_dir else "")
        self.active = {a.lower() for a in active}
        self.plugins = {k.lower(): v for k, v in (plugins or {}).items()}
        self._crc = crc

    def path(self, rel):
        rel = rel.replace("\\", "/")
        if not self.data_dir or rel.startswith("/") or re.match(r"^[a-zA-Z]:", rel):
            return None
        full = os.path.normpath(os.path.join(self.data_dir, *rel.split("/")))
        root = os.path.normpath(self.game_dir or self.data_dir)
        if full != root and not full.startswith(root + os.sep):
            return None
        return full

    def exists(self, rel):
        low = rel.lower()
        if low in self.plugins:
            return True
        p = self.path(rel)
        return bool(p and os.path.exists(p))

    def matching(self, pattern):
        """Files in the folder of a regex path whose name matches it."""
        rel = pattern.replace("\\/", "\x00")
        d, _, base = rel.rpartition("/")
        base = base.replace("\x00", "/")
        try:
            rx = re.compile(base, re.IGNORECASE)
        except re.error:
            return None
        if not d:
            names = set(self.plugins)
            p = self.path(".")
            if p:
                try:
                    names |= {n.lower() for n in os.listdir(p)}
                except OSError:
                    pass
            return [n for n in names if rx.fullmatch(n)]
        p = self.path(d.replace("\x00", "/"))
        if not p:
            return None
        try:
            return [n for n in os.listdir(p) if rx.fullmatch(n)]
        except OSError:
            return []

    def crc(self, rel):
        if self._crc is None:
            return None
        return self._crc(rel)


def _regex_path(s):
    return any(c in s for c in ":*?|") or "\\." in s or "(" in s or "[" in s


def _call(fn, args, ctx):
    try:
        if fn == "file":
            p = args[0]
            if _regex_path(p):
                m = ctx.matching(p)
                return None if m is None else bool(m)
            return ctx.exists(p)
        if fn == "readable":
            return ctx.exists(args[0])
        if fn == "active":
            p = args[0]
            if _regex_path(p):
                try:
                    rx = re.compile(p, re.IGNORECASE)
                except re.error:
                    return None
                return any(rx.fullmatch(a) for a in ctx.active)
            return p.lower() in ctx.active
        if fn in ("many", "many_active"):
            try:
                rx = re.compile(args[0].rpartition("/")[2], re.IGNORECASE)
            except re.error:
                return None
            pool = ctx.active if fn == "many_active" else (ctx.matching(args[0]) or [])
            return sum(1 for a in pool if rx.fullmatch(a)) > 1
        if fn == "is_master":
            # A plugin that is not installed is not a master.
            info = ctx.plugins.get(args[0].lower())
            return bool(info and info.get("master"))
        if fn == "checksum":
            want = int(args[1], 16)
            got = ctx.crc(args[0])
            if got is None:
                return False if not ctx.exists(args[0]) else None
            return got == want
    except (IndexError, ValueError):
        return None
    return None  # version(), product_version(), file_size(), ...: unknown


def evaluate(expr, ctx):
    """A LOOT condition string: True, False, or None when it cannot be told.
    A condition that does not parse is None."""
    if not expr or not expr.strip():
        return True
    try:
        toks = _tokens(expr)
    except ValueError:
        return None
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else (None, None)

    def take():
        t = peek()
        pos[0] += 1
        return t

    def parse_or():
        vals = [parse_and()]
        while peek() == ("word", "or"):
            take()
            vals.append(parse_and())
        if any(v is True for v in vals):
            return True
        return None if any(v is None for v in vals) else False

    def parse_and():
        vals = [parse_not()]
        while peek() == ("word", "and"):
            take()
            vals.append(parse_not())
        if any(v is False for v in vals):
            return False
        return None if any(v is None for v in vals) else True

    def parse_not():
        if peek() == ("word", "not"):
            take()
            v = parse_not()
            return None if v is None else not v
        return parse_atom()

    def parse_atom():
        kind, val = take()
        if (kind, val) == ("op", "("):
            v = parse_or()
            if take() != ("op", ")"):
                raise ValueError("missing )")
            return v
        if kind != "word" or peek() != ("op", "("):
            raise ValueError("expected a function")
        take()
        args = []
        while peek() != ("op", ")"):
            k, a = take()
            if k is None:
                raise ValueError("missing )")
            if (k, a) != ("op", ","):
                args.append(a)
        take()
        return _call(val, args, ctx)

    try:
        v = parse_or()
        if pos[0] != len(toks):
            return None
        return v
    except (ValueError, IndexError):
        return None


# ---- sorting --------------------------------------------------------------------

_VIRTUAL = "\x00masters-done"


def _find_cycle(nodes, succ):
    """One cycle among `nodes` (all of which are stuck), as a list."""
    nodes = set(nodes)
    color = {}
    for start in sorted(nodes):
        if color.get(start):
            continue
        stack = [(start, iter(sorted(succ.get(start, ()))))]
        path = [start]
        color[start] = 1
        while stack:
            node, it = stack[-1]
            nxt = next((n for n in it if n in nodes), None)
            if nxt is None:
                color[node] = 2
                stack.pop()
                path.pop()
                continue
            if color.get(nxt) == 1:
                return path[path.index(nxt):] + [nxt]
            if not color.get(nxt):
                color[nxt] = 1
                path.append(nxt)
                stack.append((nxt, iter(sorted(succ.get(nxt, ())))))
    return sorted(nodes)


def sort_plugins(order, plugins, masterlist=None, ctx=None, pins=None):
    """LOOT-style sort of `order` (names, the current load order without the
    game's own fixed plugins).

    plugins: lower name -> {"name", "master": bool, "masters": [names]}.
    pins: lower name -> wanted index (a pinned plugin keeps its place).

    Hard rules (an order that breaks one is never produced): every plugin
    after its masters; master files before the rest (unless a master needs
    that plugin); the masterlist's "after" and "req" rules whose condition
    holds. A cycle among them is reported and the order is returned as it
    was. Soft rules: the masterlist's groups, then the current order as the
    tie-break, so a valid order is left exactly as it was.

    Returns {"order", "changed", "cycle", "notes", "moved"}.
    """
    masterlist = masterlist or Masterlist()
    pins = {k.lower(): int(v) for k, v in (pins or {}).items()}
    seen, names = set(), []
    for n in order:
        low = n.lower()
        if low in plugins and low not in seen:
            seen.add(low)
            names.append(low)
    idx = {n: i for i, n in enumerate(names)}
    spelled = {n: plugins[n].get("name") or n for n in names}
    succ = {n: set() for n in names}
    pred = {n: set() for n in names}
    why = {}

    def edge(a, b, reason):
        if a == b or a not in succ or b not in succ:
            return
        if b not in succ[a]:
            succ[a].add(b)
            pred[b].add(a)
            why.setdefault((a, b), reason)

    metas = {n: masterlist.lookup(spelled[n]) for n in names}
    header_pred = {n: set() for n in names}
    for n in names:
        for m in plugins[n].get("masters") or []:
            edge(m.lower(), n, "master")
            if m.lower() in header_pred and m.lower() != n:
                header_pred[n].add(m.lower())
        for key in ("after", "req"):
            for f in metas[n][key]:
                cond = f.get("condition")
                if cond and evaluate(cond, ctx or ConditionContext()) is not True:
                    continue
                edge(f["name"].lower(), n, key)

    # Masters first, through one virtual node: master -> V -> non-master,
    # except non-masters a master names in its header (directly or through
    # others): the game loads those before the master too.
    masters = {n for n in names if plugins[n].get("master")}
    needed = set()
    frontier = [m for m in masters]
    while frontier:
        cur = frontier.pop()
        for p in header_pred[cur]:
            if p not in masters and p not in needed:
                needed.add(p)
                frontier.append(p)
    if masters and len(masters) < len(names):
        succ[_VIRTUAL], pred[_VIRTUAL] = set(), set()
        for n in names:
            if n in masters:
                edge(n, _VIRTUAL, "flags")
            elif n not in needed:
                edge(_VIRTUAL, n, "flags")
        idx[_VIRTUAL] = -1

    # Groups.
    anc = masterlist.ancestors()
    group = {n: metas[n]["group"] or "default" for n in names}
    remaining = {}
    for n in names:
        remaining[group[n]] = remaining.get(group[n], 0) + 1

    def ready(n):
        if n == _VIRTUAL:
            return True
        return all(remaining.get(g, 0) == 0 for g in anc.get(group[n], ()))

    indeg = {n: len(pred[n]) for n in succ}
    heap = [(idx[n], n) for n in succ if indeg[n] == 0]
    heapq.heapify(heap)
    out = []
    while heap:
        skipped, pick = [], None
        while heap:
            item = heapq.heappop(heap)
            if ready(item[1]):
                pick = item
                break
            skipped.append(item)
        if pick is None:
            pick = skipped.pop(0)
        for item in skipped:
            heapq.heappush(heap, item)
        n = pick[1]
        if n != _VIRTUAL:
            out.append(n)
            remaining[group[n]] -= 1
        for s in succ[n]:
            indeg[s] -= 1
            if indeg[s] == 0:
                heapq.heappush(heap, (idx[s], s))
    notes = []
    if masterlist.group_cycle:
        notes.append("The masterlist's groups loop (" + ", ".join(masterlist.group_cycle)
                     + "), so groups were ignored.")
    if len(out) != len(names):
        stuck = [n for n in succ if indeg[n] > 0]
        cyc = [c for c in _find_cycle(stuck, succ) if c != _VIRTUAL]
        reasons = []
        for a, b in zip(cyc, cyc[1:]):
            reasons.append(why.get((a, b), "flags"))
        return {"order": [spelled[n] for n in names], "changed": False,
                "cycle": [spelled.get(c, c) for c in cyc], "cycle_rules": reasons,
                "notes": notes, "moved": 0}

    # Pins: put each pinned plugin back at its index, as close as its hard
    # rules allow.
    pinned = sorted((p for p in pins if p in idx and p != _VIRTUAL), key=lambda p: pins[p])
    hard_pred = {n: {p for p in pred[n] if p != _VIRTUAL} for n in names}
    hard_succ = {n: {s for s in succ[n] if s != _VIRTUAL} for n in names}
    for p in pinned:
        out.remove(p)
    for p in pinned:
        want = max(0, min(pins[p], len(out)))
        after = set(hard_pred[p])
        before = set(hard_succ[p])
        if _VIRTUAL in succ and p in succ[_VIRTUAL]:
            after |= masters
        if _VIRTUAL in pred and p in pred[_VIRTUAL]:
            before |= {n for n in names if n not in masters and n not in needed}
        lo = max([out.index(a) + 1 for a in after if a in out] or [0])
        hi = min([out.index(b) for b in before if b in out] or [len(out)])
        if lo > hi:
            notes.append(f"{spelled[p]} could not stay pinned: its rules contradict each other.")
            lo = hi = max(0, min(hi, len(out)))
        at = max(lo, min(want, hi))
        if at != want:
            notes.append(f"{spelled[p]} is pinned at {want + 1} but has to load "
                         f"{'later' if at > want else 'earlier'}, so it sits at {at + 1}.")
        out.insert(at, p)
    moved = sum(1 for i, n in enumerate(out) if names[i] != n)
    return {"order": [spelled[n] for n in out], "changed": moved > 0, "cycle": [],
            "cycle_rules": [], "notes": notes, "moved": moved}


def order_violations(order, plugins):
    """The rules an order breaks, keyed by the offending plugin so the same
    fault reads the same before and after a move: ("needs", plugin, master)
    for a plugin before a master it names, ("master", plugin, "") for a
    master file after a regular plugin."""
    pos = {n.lower(): i for i, n in enumerate(order)}
    out = set()
    seen_regular = False
    for i, n in enumerate(order):
        info = plugins.get(n.lower()) or {}
        for m in info.get("masters") or []:
            j = pos.get(m.lower())
            if j is not None and j > i:
                out.add(("needs", n.lower(), m.lower()))
        if info.get("master"):
            if seen_regular:
                out.add(("master", n.lower(), ""))
        else:
            seen_regular = True
    return out


# ---- the files --------------------------------------------------------------------

def decode_text(raw):
    """(text, encoding): UTF-8 when it decodes, else Windows-1252 (what the
    games themselves write)."""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace"), "utf-8-sig"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace"), "cp1252"


def newline_of(text, default="\r\n"):
    if "\r\n" in text:
        return "\r\n"
    if "\n" in text:
        return "\n"
    return default


def parse_plugins_txt(text, method):
    """(comment lines, [(name, active)]) from plugins.txt."""
    header, entries, seen = [], [], set()
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            header.append(s)
            continue
        active = method == "textfile" or s.startswith("*")
        name = s.lstrip("*").strip() if method == "asterisk" else s
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        entries.append((name, active))
    return header, entries


def parse_loadorder_txt(text):
    out, seen = [], set()
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#") and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


def read_state(game, plugins_text, loadorder_text, on_disk):
    """The load order and the active set from the game's files.

    on_disk: plugin file names in the Data folder (as spelled there).
    Returns {"order": [...], "active": set(lower), "header": [...],
    "fixed": [...], "missing": [...]}: `order` excludes the game's own fixed
    plugins (`fixed`, present ones, in their hardcoded order) and plugins
    listed but not on disk (`missing`, with their active state kept)."""
    disk = {n.lower(): n for n in on_disk}
    implicit = [n for n in game["implicit"] if n.lower() in disk]
    implicit_low = {n.lower() for n in game["implicit"]}
    header, entries = parse_plugins_txt(plugins_text or "", game["method"])
    active = {n.lower() for n, on in entries if on}
    missing = [(n, on) for n, on in entries if n.lower() not in disk and n.lower() not in implicit_low]
    order = []
    if game["method"] == "textfile" and loadorder_text:
        lo = [n for n in parse_loadorder_txt(loadorder_text) if n.lower() in disk]
        # The game reads plugins.txt: when loadorder.txt disagrees about the
        # active plugins' order, plugins.txt wins and loadorder.txt is ignored.
        act_lo = [n.lower() for n in lo if n.lower() in active]
        act_pt = [n.lower() for n, _ in entries if n.lower() in disk]
        if act_lo == [a for a in act_pt if a in set(act_lo)] and set(act_pt) <= {n.lower() for n in lo}:
            order = lo
    if not order:
        order = [disk[n.lower()] for n, _ in entries if n.lower() in disk]
    have = {n.lower() for n in order}
    order += sorted((disk[k] for k in disk if k not in have), key=str.lower)
    order = [n for n in order if n.lower() not in implicit_low]
    return {"order": order, "active": active | {n.lower() for n in implicit},
            "header": header, "fixed": implicit, "missing": missing}


def render(game, order, active, header=(), missing=(), newline="\r\n", blueprint=()):
    """(plugins.txt text, loadorder.txt text or None) for an order.

    Asterisk games: every plugin, '*' on the active ones; the game's own
    fixed plugins and Starfield's blueprint masters are not written (the game
    loads them by itself). Text-file games: plugins.txt holds the active
    plugins in order, loadorder.txt every plugin."""
    act = {a.lower() for a in active}
    skip = {n.lower() for n in game["implicit"]} | {b.lower() for b in blueprint}
    names = [n for n in order if n.lower() not in skip]
    extra = [(n, on) for n, on in missing if n.lower() not in skip]
    if game["method"] == "asterisk":
        lines = list(header) + [("*" + n if n.lower() in act else n) for n in names]
        lines += [("*" + n if on else n) for n, on in extra]
        return newline.join(lines) + newline if lines else "", None
    plugins = list(header) + [n for n in names if n.lower() in act] + [n for n, on in extra if on]
    lo = list(names) + [n for n, _ in extra]
    return (newline.join(plugins) + newline if plugins else ""), (newline.join(lo) + newline if lo else "")


# ---- warnings ---------------------------------------------------------------------

def _crc_hit(meta, crc):
    for d in meta["dirty"]:
        if d["crc"] == crc:
            return d
    return None


def warnings(game, order, active, plugins, masterlist, ctx, fixed=(), crc=None):
    """Per plugin and global warnings, each {"plugin", "level", "text"};
    level "error" (crimson) or "warn" (amber). Only active plugins are
    checked: an inactive one does not load."""
    masterlist = masterlist or Masterlist()
    act = {a.lower() for a in active}
    disk = {k for k in plugins}
    out = []
    for n in list(fixed) + list(order):
        low = n.lower()
        if low not in act or low not in plugins:
            continue
        info = plugins[low]
        for m in info.get("masters") or []:
            ml = m.lower()
            if ml not in disk:
                out.append({"plugin": n, "level": "error", "text": f"Needs {m}, which is not installed."})
            elif ml not in act:
                out.append({"plugin": n, "level": "error", "text": f"Needs {m}, which is switched off."})
        meta = masterlist.lookup(n)
        for f in meta["req"]:
            if f.get("condition") and evaluate(f["condition"], ctx) is not True:
                continue
            label = plain_text(f.get("display") or f["name"])
            fl = f["name"].lower()
            if is_plugin_name(f["name"]):
                if fl not in disk:
                    out.append({"plugin": n, "level": "error", "text": f"Needs {label}, which is not installed (LOOT)."})
                elif fl not in act:
                    out.append({"plugin": n, "level": "warn", "text": f"Needs {label}, which is switched off (LOOT)."})
            elif not ctx.exists(f["name"]):
                out.append({"plugin": n, "level": "error", "text": f"Needs {label}, which is not installed (LOOT)."})
        for f in meta["inc"]:
            if f.get("condition") and evaluate(f["condition"], ctx) is not True:
                continue
            fl = f["name"].lower()
            hit = fl in act if is_plugin_name(f["name"]) else ctx.exists(f["name"])
            if hit:
                label = plain_text(f.get("display") or f["name"])
                out.append({"plugin": n, "level": "error", "text": f"Incompatible with {label} (LOOT)."})
        if meta["dirty"] and crc is not None:
            got = crc(n)
            d = _crc_hit(meta, got) if got is not None else None
            if d:
                bits = []
                if d.get("itm"):
                    bits.append(f"{d['itm']} identical-to-master records")
                if d.get("udr"):
                    bits.append(f"{d['udr']} deleted references")
                if d.get("nav"):
                    bits.append(f"{d['nav']} deleted navmeshes")
                tool = d.get("util") or game.get("cleaner") or "xEdit"
                out.append({"plugin": n, "level": "warn",
                            "text": "Dirty" + (f": {', '.join(bits)}" if bits else "")
                            + f". LOOT suggests cleaning it with {tool}."})
        for m in meta["msg"]:
            if m["type"] not in ("warn", "error"):
                continue
            if m.get("condition") and evaluate(m["condition"], ctx) is not True:
                continue
            out.append({"plugin": n, "level": m["type"], "text": m["text"]})
    for m in masterlist.globals:
        if m["type"] in ("warn", "error") and (not m.get("condition") or evaluate(m["condition"], ctx) is True):
            out.append({"plugin": "", "level": m["type"], "text": m["text"]})
    return out


# ---- crc32 ------------------------------------------------------------------------

_CRC_TABLE = None
PURE_CRC_LIMIT = 8 << 20


def crc32_bytes(data, crc=0):
    global _CRC_TABLE
    if _CRC_TABLE is None:
        table = []
        for i in range(256):
            c = i
            for _ in range(8):
                c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1
            table.append(c)
        _CRC_TABLE = table
    t = _CRC_TABLE
    crc ^= 0xFFFFFFFF
    for b in data:
        crc = t[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


def crc32_file(path):
    """CRC-32 of a file: zlib when the runtime has it (CPython on Windows has
    it built in), else pure Python for files up to 8 MB. None when it cannot
    be read or is too big for the fallback."""
    try:
        import zlib
        fn = zlib.crc32
    except ImportError:
        fn = None
    try:
        if fn is None and os.path.getsize(path) > PURE_CRC_LIMIT:
            return None
        crc = 0
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                crc = fn(chunk, crc) if fn else crc32_bytes(chunk, crc)
        return crc & 0xFFFFFFFF
    except OSError:
        return None


# ---- deploy profiles -------------------------------------------------------------

PROFILE_NAME = re.compile(r"[^\x00-\x1f<>:\"/\\|?*]{1,40}")
PROFILE_PRESETS = ("Vanilla+", "Full modlist", "Light", "Testing")
MAX_PROFILES = 20


def clean_profile_name(name):
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    return name if PROFILE_NAME.fullmatch(name) else ""


def snapshot(mods, order, active):
    """A profile from the live state: mods [{folder, enabled}], the plugin
    order and the active plugins."""
    folders = sorted({str(m.get("folder")) for m in mods or [] if m.get("folder")})
    enabled = sorted({str(m.get("folder")) for m in mods or [] if m.get("folder") and m.get("enabled")})
    act = {a.lower() for a in active}
    return {"mods": enabled, "known_mods": folders, "order": list(order),
            "active": [n for n in order if n.lower() in act]}


def profile_plan(profile, mods):
    """The mod switches that make the installed mods match a profile.

    A mod the profile has never seen (installed after it was saved) is
    switched off, as in other mod managers' profiles; a mod that cannot be
    switched ("always on") is left alone. Returns {"changes": [{folder,
    enabled}], "missing": [folders the profile wants that are gone],
    "new_off": [folders switched off because the profile never saw them]}."""
    want = set(profile.get("mods") or [])
    known = set(profile.get("known_mods") or []) | want
    changes, new_off = [], []
    installed = set()
    for m in mods or []:
        folder = str(m.get("folder") or "")
        if not folder:
            continue
        installed.add(folder)
        if m.get("togglable") is False:
            continue
        on = folder in want
        if bool(m.get("enabled")) != on:
            changes.append({"folder": folder, "enabled": on})
            if not on and folder not in known:
                new_off.append(folder)
    # Off first: a profile with fewer mods frees files before others go in.
    changes.sort(key=lambda c: (c["enabled"], c["folder"].lower()))
    return {"changes": changes, "missing": sorted(want - installed), "new_off": sorted(new_off)}


def profile_order(profile, current_order, current_active, plugins, skipped=()):
    """The load order and active plugins a profile asks for, fitted to what
    is on disk now.

    Plugins the profile names keep its order; plugins it never saw keep their
    place relative to each other at the end and their current state (they
    belong to mods the profile switch just put in or took out). Then: masters
    an active plugin needs are switched on (unless skipped), and plugins
    whose master is missing or skipped are switched off. Returns (order,
    active set, notes)."""
    known_low = {n.lower() for n in profile.get("order") or []}
    disk = set(plugins)
    order = [n for n in profile.get("order") or [] if n.lower() in disk]
    have = {n.lower() for n in order}
    order += [n for n in current_order if n.lower() not in have and n.lower() in disk]
    seen = set()
    order = [n for n in order if not (n.lower() in seen or seen.add(n.lower()))]
    cur_act = {a.lower() for a in current_active}
    active = {n.lower() for n in profile.get("active") or [] if n.lower() in disk}
    active |= {n.lower() for n in order if n.lower() not in known_low and n.lower() in cur_act}
    skipped = {s.lower() for s in skipped}
    notes = []
    for s in sorted(active & skipped):
        notes.append(f"{plugins[s].get('name', s)} stays off (switched off earlier because it breaks the game).")
    active -= skipped
    changed = True
    while changed:
        changed = False
        for n in list(active):
            for m in plugins.get(n, {}).get("masters") or []:
                ml = m.lower()
                if ml in active:
                    continue
                if ml in disk and ml not in skipped:
                    active.add(ml)
                    changed = True
                elif ml not in disk or ml in skipped:
                    active.discard(n)
                    notes.append(f"{plugins[n].get('name', n)} is off: it needs {m}, which "
                                 + ("is not installed." if ml not in disk else "stays off."))
                    changed = True
                    break
    return order, active, notes
