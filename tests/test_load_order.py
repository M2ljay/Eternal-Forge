"""Forge: LOOT-style load order and deploy profiles.

Plugin headers from fixture bytes, the YAML subset LOOT's masterlists use,
the sort on small synthetic masterlists (cycles included), plugins.txt /
loadorder.txt per game, warnings, the masterlist cache (offline included),
and a profile switch round trip against a fake game folder."""
import asyncio
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest
from unittest import mock

from test_backend import main

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
import load_order as lo  # noqa: E402

SSE = lo.GAMES["skyrimspecialedition"]
FO4 = lo.GAMES["fallout4"]
SF = lo.GAMES["starfield"]
OR = lo.GAMES["oblivionremastered"]


def run(coro):
    return asyncio.run(coro)


def plugin_bytes(masters=(), flags=0, header=24, extended=False):
    """A minimal plugin: the TES4 record with HEDR and MAST/DATA pairs."""
    sub = b"HEDR" + struct.pack("<H", 12) + struct.pack("<fII", 1.7, 0, 0x800)
    if extended:
        sub += b"XXXX" + struct.pack("<H", 4) + struct.pack("<I", 5) + b"SNAM" + struct.pack("<H", 0) + b"long\0"
    for m in masters:
        name = m.encode("cp1252") + b"\0"
        sub += b"MAST" + struct.pack("<H", len(name)) + name + b"DATA" + struct.pack("<H", 8) + b"\0" * 8
    return b"TES4" + struct.pack("<II", len(sub), flags) + b"\0" * (header - 12) + sub


def info(name, master=False, masters=()):
    return {"name": name, "master": master, "masters": list(masters)}


def plugins_of(*items):
    return {i["name"].lower(): i for i in items}


class HeaderTests(unittest.TestCase):
    def test_masters_and_master_flag(self):
        h = lo.parse_header(plugin_bytes(["Skyrim.esm", "Update.esm"], flags=1), SSE)
        self.assertEqual(h["masters"], ["Skyrim.esm", "Update.esm"])
        self.assertTrue(h["master"])
        self.assertFalse(h["light"])

    def test_esl_flag_differs_per_game(self):
        self.assertTrue(lo.parse_header(plugin_bytes(flags=0x200), SSE)["light"])
        self.assertTrue(lo.parse_header(plugin_bytes(flags=0x200), FO4)["light"])
        # Starfield moved "small" to 0x100; 0x200 is its update flag.
        self.assertFalse(lo.parse_header(plugin_bytes(flags=0x200), SF)["light"])
        self.assertTrue(lo.parse_header(plugin_bytes(flags=0x100), SF)["light"])
        self.assertTrue(lo.parse_header(plugin_bytes(flags=0x400), SF)["medium"])
        self.assertTrue(lo.parse_header(plugin_bytes(flags=0x801), SF)["blueprint"])
        self.assertFalse(lo.parse_header(plugin_bytes(flags=0x200), OR)["light"])

    def test_extension_implies_master_except_oblivion(self):
        self.assertTrue(lo.plugin_kind("x.esm", 0, SSE)["master"])
        self.assertTrue(lo.plugin_kind("x.esl", 0, SSE)["light"])
        self.assertFalse(lo.plugin_kind("x.esm", 0, OR)["master"])
        self.assertTrue(lo.plugin_kind("x.esp", 1, OR)["master"])

    def test_oblivion_header_is_twenty_bytes(self):
        data = plugin_bytes(["Oblivion.esm"], header=20)
        self.assertEqual(lo.parse_header(data, OR)["masters"], ["Oblivion.esm"])
        # Read with the 24-byte layout it misses the master.
        self.assertNotEqual(lo.parse_header(data, SSE)["masters"], ["Oblivion.esm"])

    def test_extended_subrecord_is_skipped(self):
        h = lo.parse_header(plugin_bytes(["A.esm"], extended=True), SSE)
        self.assertEqual(h["masters"], ["A.esm"])

    def test_not_a_plugin(self):
        self.assertIsNone(lo.parse_header(b"TES3" + b"\0" * 40, SSE))
        self.assertIsNone(lo.parse_header(b"TES4\0\0", SSE))

    def test_truncated_body_does_not_raise(self):
        data = plugin_bytes(["A.esm", "B.esm"])[:-12]
        self.assertEqual(lo.parse_header(data, SSE)["masters"][:1], ["A.esm"])

    def test_read_header_from_disk_uses_the_file_name(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "Thing.esl")
            with open(path, "wb") as f:
                f.write(plugin_bytes(["Skyrim.esm"]))
            h = lo.read_header(path, SSE)
            self.assertTrue(h["master"] and h["light"])
        finally:
            shutil.rmtree(d)


class YamlTests(unittest.TestCase):
    def test_anchors_merge_and_flow(self):
        doc = lo.parse_yaml(
            "common:\n"
            "  - &dirt\n"
            "    type: warn\n"
            "    content: 'It''s dirty {0}.'\n"
            "groups:\n"
            "  - name: &early Early\n"
            "  - name: default\n"
            "    after: [ *early ]\n"
            "plugins:\n"
            "  - name: 'A.esp'  # comment\n"
            "    msg:\n"
            "      - <<: *dirt\n"
            "        subs: [ 'now' ]\n"
            "    dirty:\n"
            "      - crc: 0xDEADBEEF\n"
            "        itm: 3\n")
        self.assertEqual(doc["groups"][1]["after"], ["Early"])
        msg = doc["plugins"][0]["msg"][0]
        self.assertEqual((msg["type"], msg["content"], msg["subs"]), ("warn", "It's dirty {0}.", ["now"]))
        self.assertEqual(doc["plugins"][0]["dirty"][0]["crc"], 0xDEADBEEF)

    def test_multiline_quoted_and_block_scalars(self):
        doc = lo.parse_yaml("a: 'one\n  two\n\n  three'\nb: >-\n  x\n  y\nc: |\n  l1\n  l2\nd: \"q\\\"\"\n")
        self.assertEqual(doc, {"a": "one two\nthree", "b": "x y", "c": "l1\nl2\n", "d": 'q"'})

    def test_sequence_at_the_keys_indent(self):
        self.assertEqual(lo.parse_yaml("k:\n- 1\n- two\n"), {"k": [1, "two"]})

    def test_unknown_alias_is_null_not_a_crash(self):
        self.assertEqual(lo.parse_yaml("a: *nope\n"), {"a": None})

    def test_reduce_rejects_a_non_masterlist(self):
        with self.assertRaises(lo.YamlError):
            lo.reduce_masterlist(lo.parse_yaml("hello: world\n"))


def masterlist(text):
    return lo.Masterlist(lo.reduce_masterlist(lo.parse_yaml(text)))


class MasterlistTests(unittest.TestCase):
    def test_exact_and_regex_entries_merge(self):
        ml = masterlist(
            "groups:\n  - name: default\n  - name: Late\n    after: [ default ]\n"
            "plugins:\n"
            "  - name: 'Patch.esp'\n    group: Late\n    after: [ 'A.esp' ]\n"
            "  - name: 'Pat.*\\.esp'\n    after: [ 'B.esp' ]\n    group: default\n")
        meta = ml.lookup("Patch.esp")
        self.assertEqual(meta["group"], "Late")
        self.assertEqual([f["name"] for f in meta["after"]], ["A.esp", "B.esp"])
        self.assertEqual(ml.lookup("Other.esp")["group"], "default")

    def test_markdown_becomes_plain_text(self):
        self.assertEqual(lo.plain_text("Use **[SSEEdit](https://x/164)** now"), "Use SSEEdit now")


class ConditionTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.data = os.path.join(self.d, "Data")
        os.makedirs(os.path.join(self.data, "SKSE", "Plugins"))
        open(os.path.join(self.d, "SkyrimSE.exe"), "w").close()
        open(os.path.join(self.data, "SKSE", "Plugins", "po3_Tweaks.dll"), "w").close()
        self.ctx = lo.ConditionContext(self.data, self.d, active={"A.esp"},
                                       plugins={"a.esp": {"master": False}, "b.esm": {"master": True}},
                                       crc=lambda rel: 0x1234ABCD if rel == "A.esp" else None)

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_functions(self):
        e = lambda s: lo.evaluate(s, self.ctx)  # noqa: E731
        self.assertTrue(e('file("../SkyrimSE.exe")'))
        self.assertFalse(e('file("Missing.esp")'))
        self.assertTrue(e('file("SKSE/Plugins/po3_.+\\.dll")'))
        self.assertTrue(e('active("A.esp")'))
        self.assertTrue(e('active("a\\.es[mp]")'))
        self.assertFalse(e('active("B.esm")'))
        self.assertTrue(e('is_master("B.esm")'))
        self.assertFalse(e('is_master("NotInstalled.esm")'))
        self.assertTrue(e('checksum("A.esp", 1234ABCD)'))
        self.assertFalse(e('checksum("Gone.esp", 1234ABCD)'))

    def test_three_valued_logic(self):
        e = lambda s: lo.evaluate(s, self.ctx)  # noqa: E731
        self.assertIsNone(e('version("../SkyrimSE.exe", "1.6", >=)'))
        self.assertIsNone(e('not version("x", "1", <)'))
        self.assertTrue(e('active("A.esp") or version("x", "1", <)'))
        self.assertFalse(e('active("B.esm") and version("x", "1", <)'))
        self.assertTrue(e('(file("Missing.esp") or active("A.esp")) and not file("Missing.esp")'))

    def test_bad_syntax_is_unknown(self):
        self.assertIsNone(lo.evaluate('file("x"', self.ctx))
        self.assertIsNone(lo.evaluate('frobnicate', self.ctx))

    def test_paths_stay_inside_the_game(self):
        self.assertFalse(lo.evaluate('file("../../../../etc/passwd")', self.ctx))


class SortTests(unittest.TestCase):
    def test_a_valid_order_is_left_alone(self):
        p = plugins_of(info("A.esm", True), info("B.esp", masters=["A.esm"]), info("C.esp"))
        r = lo.sort_plugins(["A.esm", "C.esp", "B.esp"], p)
        self.assertEqual(r["order"], ["A.esm", "C.esp", "B.esp"])
        self.assertFalse(r["changed"])

    def test_masters_first_and_masters_before_dependents(self):
        p = plugins_of(info("Patch.esp", masters=["Mod.esp", "Base.esm"]), info("Mod.esp"),
                       info("Base.esm", True), info("Other.esm", True, ["Base.esm"]))
        r = lo.sort_plugins(["Patch.esp", "Mod.esp", "Other.esm", "Base.esm"], p)
        self.assertEqual(r["order"], ["Base.esm", "Other.esm", "Mod.esp", "Patch.esp"])
        self.assertTrue(r["changed"])

    def test_a_master_that_needs_a_plugin_keeps_it_above(self):
        p = plugins_of(info("Odd.esm", True, ["Needed.esp"]), info("Needed.esp"), info("Late.esp"))
        r = lo.sort_plugins(["Late.esp", "Odd.esm", "Needed.esp"], p)
        self.assertEqual(r["order"], ["Needed.esp", "Odd.esm", "Late.esp"])

    def test_masterlist_after_and_req(self):
        ml = masterlist("plugins:\n  - name: 'A.esp'\n    after: [ 'B.esp' ]\n"
                        "  - name: 'C.esp'\n    req: [ 'A.esp' ]\n")
        p = plugins_of(info("A.esp"), info("B.esp"), info("C.esp"))
        r = lo.sort_plugins(["C.esp", "A.esp", "B.esp"], p, ml)
        self.assertEqual(r["order"], ["B.esp", "A.esp", "C.esp"])

    def test_conditional_rule_only_when_true(self):
        ml = masterlist("plugins:\n  - name: 'A.esp'\n    after:\n"
                        "      - name: 'B.esp'\n        condition: 'active(\"X.esp\")'\n")
        p = plugins_of(info("A.esp"), info("B.esp"))
        off = lo.sort_plugins(["A.esp", "B.esp"], p, ml, lo.ConditionContext(active=[]))
        self.assertEqual(off["order"], ["A.esp", "B.esp"])
        on = lo.sort_plugins(["A.esp", "B.esp"], p, ml, lo.ConditionContext(active=["X.esp"]))
        self.assertEqual(on["order"], ["B.esp", "A.esp"])

    def test_groups_are_soft(self):
        ml = masterlist("groups:\n  - name: Early\n  - name: default\n    after: [ Early ]\n"
                        "  - name: Late\n    after: [ default ]\n"
                        "plugins:\n  - name: 'Fix.esp'\n    group: Early\n"
                        "  - name: 'Last.esp'\n    group: Late\n")
        p = plugins_of(info("Last.esp"), info("Mid.esp"), info("Fix.esp"), info("Mid2.esp", masters=["Last.esp"]))
        r = lo.sort_plugins(["Last.esp", "Mid.esp", "Fix.esp", "Mid2.esp"], p, ml)
        # Fix goes first, Last after Mid; Mid2 needs Last (a hard rule beats
        # its group), so it follows Last.
        self.assertEqual(r["order"], ["Fix.esp", "Mid.esp", "Last.esp", "Mid2.esp"])

    def test_a_cycle_is_reported_and_nothing_moves(self):
        ml = masterlist("plugins:\n  - name: 'A.esp'\n    after: [ 'B.esp' ]\n"
                        "  - name: 'B.esp'\n    after: [ 'C.esp' ]\n"
                        "  - name: 'C.esp'\n    after: [ 'A.esp' ]\n")
        p = plugins_of(info("A.esp"), info("B.esp"), info("C.esp"), info("D.esp"))
        r = lo.sort_plugins(["D.esp", "C.esp", "B.esp", "A.esp"], p, ml)
        self.assertFalse(r["changed"])
        self.assertEqual(r["order"], ["D.esp", "C.esp", "B.esp", "A.esp"])
        self.assertEqual(set(r["cycle"]), {"A.esp", "B.esp", "C.esp"})
        self.assertEqual(r["cycle"][0], r["cycle"][-1])

    def test_a_master_cycle_in_the_headers(self):
        p = plugins_of(info("A.esp", masters=["B.esp"]), info("B.esp", masters=["A.esp"]))
        r = lo.sort_plugins(["A.esp", "B.esp"], p)
        self.assertEqual(r["order"], ["A.esp", "B.esp"])
        self.assertTrue(r["cycle"])

    def test_a_cycle_through_the_master_flag(self):
        # A master after a regular plugin by masterlist rule: master -> V -> esp -> master.
        ml = masterlist("plugins:\n  - name: 'M.esm'\n    after: [ 'P.esp' ]\n")
        p = plugins_of(info("M.esm", True), info("P.esp"), info("Q.esp"))
        r = lo.sort_plugins(["M.esm", "P.esp", "Q.esp"], p, ml)
        self.assertEqual(r["order"], ["M.esm", "P.esp", "Q.esp"])
        self.assertIn("M.esm", r["cycle"])
        self.assertNotIn(lo._VIRTUAL, r["cycle"])

    def test_a_group_cycle_is_ignored_with_a_note(self):
        ml = masterlist("groups:\n  - name: default\n    after: [ X ]\n  - name: X\n    after: [ default ]\n"
                        "plugins:\n  - name: 'A.esp'\n    group: X\n")
        p = plugins_of(info("A.esp"), info("B.esp"))
        r = lo.sort_plugins(["B.esp", "A.esp"], p, ml)
        self.assertEqual(r["order"], ["B.esp", "A.esp"])
        self.assertTrue(any("loop" in n for n in r["notes"]))

    def test_pins_hold_their_place(self):
        ml = masterlist("plugins:\n  - name: 'A.esp'\n    after: [ 'C.esp' ]\n")
        p = plugins_of(info("A.esp"), info("B.esp"), info("C.esp"))
        r = lo.sort_plugins(["A.esp", "B.esp", "C.esp"], p, ml, pins={"b.esp": 0})
        self.assertEqual(r["order"][0], "B.esp")
        self.assertEqual(r["order"].index("C.esp") < r["order"].index("A.esp"), True)

    def test_a_pin_above_its_master_is_clamped_with_a_note(self):
        p = plugins_of(info("Base.esm", True), info("Mod.esp", masters=["Base.esm"]), info("X.esp"))
        r = lo.sort_plugins(["Base.esm", "X.esp", "Mod.esp"], p, pins={"mod.esp": 0})
        self.assertEqual(r["order"], ["Base.esm", "Mod.esp", "X.esp"])
        self.assertTrue(any("pinned" in n for n in r["notes"]))

    def test_unknown_plugins_and_duplicates_are_dropped(self):
        p = plugins_of(info("A.esp"))
        self.assertEqual(lo.sort_plugins(["A.esp", "a.esp", "Ghost.esp"], p)["order"], ["A.esp"])

    def test_a_large_list_sorts_quickly(self):
        names = [f"P{i:04}.esp" for i in range(2000)]
        p = {n.lower(): info(n, masters=[names[i - 1]] if i % 7 == 0 and i else []) for i, n in enumerate(names)}
        t = time.time()
        r = lo.sort_plugins(list(reversed(names)), p)
        self.assertLess(time.time() - t, 5)
        self.assertFalse(r["cycle"])


class FileFormatTests(unittest.TestCase):
    def test_asterisk_game_round_trip(self):
        text = ("# This file is used by the game\r\n*Skyrim.esm\r\n*A.esp\r\nB.esp\r\n*Gone.esp\r\n")
        st = lo.read_state(SSE, text, "", ["Skyrim.esm", "Update.esm", "A.esp", "B.esp", "C.esm"])
        self.assertEqual(st["order"], ["A.esp", "B.esp", "C.esm"])
        self.assertEqual(st["fixed"], ["Skyrim.esm", "Update.esm"])
        self.assertIn("a.esp", st["active"])
        self.assertNotIn("b.esp", st["active"])
        self.assertEqual(st["missing"], [("Gone.esp", True)])
        out, lot = lo.render(SSE, ["C.esm", "A.esp", "B.esp"], st["active"], st["header"], st["missing"], "\r\n")
        self.assertIsNone(lot)
        self.assertEqual(out, "# This file is used by the game\r\nC.esm\r\n*A.esp\r\nB.esp\r\n*Gone.esp\r\n")

    def test_fallout4_and_starfield_skip_their_own_plugins(self):
        out, _ = lo.render(FO4, ["Fallout4.esm", "Mod.esp"], {"fallout4.esm", "mod.esp"}, newline="\n")
        self.assertEqual(out, "*Mod.esp\n")
        out, _ = lo.render(SF, ["Starfield.esm", "Mod.esm", "BP.esm"], {"mod.esm", "bp.esm"},
                           newline="\n", blueprint=["BP.esm"])
        self.assertEqual(out, "*Mod.esm\n")

    def test_oblivion_remastered_writes_both_files(self):
        pt = "Oblivion.esm\nDLCShiveringIsles.esp\nMod.esp\n"
        lot = "Oblivion.esm\nOff.esp\nDLCShiveringIsles.esp\nMod.esp\n"
        disk = ["Oblivion.esm", "DLCShiveringIsles.esp", "Mod.esp", "Off.esp"]
        st = lo.read_state(OR, pt, lot, disk)
        self.assertEqual(st["order"], ["Oblivion.esm", "Off.esp", "DLCShiveringIsles.esp", "Mod.esp"])
        self.assertEqual(st["fixed"], [])
        self.assertNotIn("off.esp", st["active"])
        ptxt, ltxt = lo.render(OR, st["order"], st["active"], newline="\r\n")
        self.assertEqual(ptxt, "Oblivion.esm\r\nDLCShiveringIsles.esp\r\nMod.esp\r\n")
        self.assertEqual(ltxt, "Oblivion.esm\r\nOff.esp\r\nDLCShiveringIsles.esp\r\nMod.esp\r\n")

    def test_a_loadorder_txt_that_disagrees_with_plugins_txt_is_ignored(self):
        st = lo.read_state(OR, "B.esp\nA.esp\n", "A.esp\nB.esp\n", ["A.esp", "B.esp"])
        self.assertEqual(st["order"], ["B.esp", "A.esp"])

    def test_unlisted_plugins_on_disk_are_appended_off(self):
        st = lo.read_state(SSE, "*A.esp\n", "", ["A.esp", "z.esp", "B.esp"])
        self.assertEqual(st["order"], ["A.esp", "B.esp", "z.esp"])
        self.assertEqual(st["active"] - {"a.esp"}, set())

    def test_encoding_and_newlines(self):
        self.assertEqual(lo.decode_text("Café.esp".encode("cp1252"))[1], "cp1252")
        self.assertEqual(lo.decode_text(b"A.esp")[1], "utf-8")
        self.assertEqual(lo.newline_of("a\r\nb"), "\r\n")
        self.assertEqual(lo.newline_of("a\nb"), "\n")


class WarningTests(unittest.TestCase):
    def test_masters_masterlist_and_dirty(self):
        ml = masterlist(
            "plugins:\n"
            "  - name: 'A.esp'\n    req: [ 'Req.esp' ]\n    inc: [ 'Bad.esp' ]\n"
            "    dirty:\n      - crc: 0x1\n        itm: 4\n        udr: 2\n        util: '[SSEEdit](https://x)'\n"
            "    msg:\n      - type: warn\n        content: 'Read **this**.'\n"
            "      - type: say\n        content: 'quiet'\n"
            "      - type: error\n        content: 'never'\n        condition: 'active(\"Nope.esp\")'\n"
            "globals:\n  - type: error\n    content: 'Global!'\n")
        p = plugins_of(info("A.esp", masters=["Gone.esm", "Off.esm"]), info("Off.esm", True),
                       info("Bad.esp"), info("Idle.esp", masters=["Gone.esm"]))
        active = {"a.esp", "bad.esp"}
        w = lo.warnings(SSE, ["Off.esm", "A.esp", "Bad.esp", "Idle.esp"], active, p, ml,
                        lo.ConditionContext(active=active, plugins=p), crc=lambda n: 0x1)
        texts = [(x["plugin"], x["level"], x["text"]) for x in w]
        self.assertIn(("A.esp", "error", "Needs Gone.esm, which is not installed."), texts)
        self.assertIn(("A.esp", "error", "Needs Off.esm, which is switched off."), texts)
        self.assertIn(("A.esp", "error", "Needs Req.esp, which is not installed (LOOT)."), texts)
        self.assertIn(("A.esp", "error", "Incompatible with Bad.esp (LOOT)."), texts)
        self.assertIn(("A.esp", "warn", "Read this."), texts)
        self.assertIn(("", "error", "Global!"), texts)
        dirty = [t for t in texts if t[2].startswith("Dirty")]
        self.assertEqual(len(dirty), 1)
        self.assertIn("4 identical-to-master records", dirty[0][2])
        self.assertIn("SSEEdit", dirty[0][2])
        self.assertFalse([t for t in texts if t[0] == "Idle.esp"], "inactive plugins are not checked")
        self.assertFalse([t for t in texts if t[2] in ("quiet", "never")])


class ProfileTests(unittest.TestCase):
    def test_plan_switches_off_first_and_names_what_is_gone(self):
        profile = {"mods": ["A", "C", "Gone"], "known_mods": ["A", "B", "C", "Gone"]}
        mods = [{"folder": "A", "enabled": False}, {"folder": "B", "enabled": True},
                {"folder": "C", "enabled": True}, {"folder": "New", "enabled": True},
                {"folder": "Core", "enabled": True, "togglable": False}]
        plan = lo.profile_plan(profile, mods)
        self.assertEqual(plan["changes"], [{"folder": "B", "enabled": False},
                                           {"folder": "New", "enabled": False},
                                           {"folder": "A", "enabled": True}])
        self.assertEqual(plan["missing"], ["Gone"])
        self.assertEqual(plan["new_off"], ["New"])

    def test_order_fits_what_is_on_disk(self):
        p = plugins_of(info("Base.esm", True), info("A.esp", masters=["Base.esm"]), info("B.esp"),
                       info("New.esp"), info("Orphan.esp", masters=["Gone.esm"]),
                       info("Skip.esp"), info("NeedsSkip.esp", masters=["Skip.esp"]))
        profile = {"order": ["B.esp", "A.esp", "Base.esm", "Removed.esp", "Orphan.esp", "Skip.esp", "NeedsSkip.esp"],
                   "active": ["A.esp", "B.esp", "Orphan.esp", "Skip.esp", "NeedsSkip.esp"]}
        order, active, notes = lo.profile_order(profile, ["New.esp", "A.esp"], {"new.esp"}, p, skipped={"skip.esp"})
        self.assertEqual(order, ["B.esp", "A.esp", "Base.esm", "Orphan.esp", "Skip.esp", "NeedsSkip.esp", "New.esp"])
        self.assertEqual(active, {"a.esp", "b.esp", "base.esm", "new.esp"})
        self.assertTrue(any("Orphan.esp" in n for n in notes))
        self.assertTrue(any("Skip.esp stays off" in n for n in notes))

    def test_names(self):
        self.assertEqual(lo.clean_profile_name("  Vanilla+  "), "Vanilla+")
        self.assertEqual(lo.clean_profile_name("a/b"), "")
        self.assertEqual(lo.clean_profile_name("x" * 41), "")


class GameLookupTests(unittest.TestCase):
    def test_by_app_id_then_domain(self):
        self.assertEqual(lo.game_for(489830)[0], "skyrimspecialedition")
        self.assertEqual(lo.game_for(2623190)[0], "oblivionremastered")
        self.assertEqual(lo.game_for(0, "starfield")[0], "starfield")
        self.assertEqual(lo.game_for(22330, "oblivion"), (None, None))

    def test_crc(self):
        self.assertEqual(lo.crc32_bytes(b"123456789"), 0xCBF43926)
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "f")
            with open(path, "wb") as f:
                f.write(b"123456789")
            self.assertEqual(lo.crc32_file(path), 0xCBF43926)
        finally:
            shutil.rmtree(d)


# ---- backend ------------------------------------------------------------------

ML_TEXT = (
    "groups:\n  - name: default\n  - name: Late\n    after: [ default ]\n"
    "plugins:\n"
    "  - name: 'Late.esp'\n    group: Late\n"
    "  - name: 'Patch.esp'\n    after: [ 'ModB.esp' ]\n"
).encode()


class FakeGame:
    """A Skyrim SE install in a temp folder: Data with plugins, plugins.txt
    under a fake %LOCALAPPDATA%."""

    def __init__(self, files, plugins_txt):
        self.root = tempfile.mkdtemp(prefix="forge-lo-")
        self.game_dir = os.path.join(self.root, "Skyrim Special Edition")
        self.data = os.path.join(self.game_dir, "Data")
        os.makedirs(self.data)
        self.ptxt = os.path.join(self.root, "AppData", "Local", "Skyrim Special Edition", "Plugins.txt")
        os.makedirs(os.path.dirname(self.ptxt))
        for name, (masters, flags) in files.items():
            with open(os.path.join(self.data, name), "wb") as f:
                f.write(plugin_bytes(masters, flags))
        with open(self.ptxt, "w", newline="") as f:
            f.write(plugins_txt)
        self.patches = [
            mock.patch.object(main, "_forge_game_dir", lambda *a, **k: self.game_dir),
            mock.patch.object(main, "_plugins_txt_path", lambda app_id, sub: self.ptxt),
            mock.patch.object(main, "_process_running", self.running),
        ]
        self.is_running = False

    async def running(self, exe):
        return self.is_running

    def __enter__(self):
        for p in self.patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def text(self):
        with open(self.ptxt, newline="") as f:
            return f.read()


GAME_FILES = {
    "Skyrim.esm": ([], 1),
    "Update.esm": (["Skyrim.esm"], 1),
    "Base.esm": (["Skyrim.esm"], 1),
    "ModA.esp": (["Base.esm"], 0),
    "ModB.esp": ([], 0),
    "Patch.esp": (["ModA.esp"], 0),
    "Late.esp": ([], 0),
}
APP = 489830
DOMAIN = "skyrimspecialedition"


class MasterlistCacheTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(main._LO_DIR, ignore_errors=True)
        main._LO_ML_CACHE.clear()
        self.calls = []

    def fake(self, responses):
        async def get(url, etag=""):
            self.calls.append((url, etag))
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        return mock.patch.object(main, "_LO_HTTP_GET", get)

    def test_download_cache_daily_and_offline(self):
        with self.fake([(200, ML_TEXT, '"e1"')]):
            meta = run(main._lo_refresh_masterlist("skyrimse"))
        self.assertEqual(meta["entries"], 2)
        self.assertIn("/loot/skyrimse/v0.26/masterlist.yaml", self.calls[0][0])
        ml, meta = main._lo_masterlist("skyrimse")
        self.assertEqual(ml.lookup("Late.esp")["group"], "Late")
        # Within a day: no request at all.
        with self.fake([]):
            run(main._lo_refresh_masterlist("skyrimse"))
        self.assertEqual(len(self.calls), 1)
        # A day later and offline: the cached copy stays.
        st = main._lo_ml_read("skyrimse")
        st["meta"]["fetched_at"] -= 2 * 24 * 3600
        st["meta"]["checked_at"] -= 2 * 24 * 3600
        main._forge_write(main._lo_ml_file("skyrimse"), st)
        with self.fake([OSError("offline")]):
            meta = run(main._lo_refresh_masterlist("skyrimse"))
        self.assertIn("offline", meta["error"])
        ml, meta = main._lo_masterlist("skyrimse")
        self.assertTrue(meta["available"])
        self.assertEqual(ml.lookup("Late.esp")["group"], "Late")
        # And it does not retry within the hour.
        with self.fake([]):
            run(main._lo_refresh_masterlist("skyrimse"))

    def test_304_and_branch_fallback(self):
        with self.fake([(404, b"", ""), (200, ML_TEXT, '"e2"')]):
            meta = run(main._lo_refresh_masterlist("skyrimse"))
        self.assertIn("/master/masterlist.yaml", meta["url"])
        with self.fake([(404, b"", ""), (304, b"", "")]):
            meta = run(main._lo_refresh_masterlist("skyrimse", force=True))
        self.assertEqual(self.calls[-1][1], '"e2"')
        self.assertEqual(meta["error"], "")

    def test_a_broken_download_keeps_the_old_copy(self):
        with self.fake([(200, ML_TEXT, "")]):
            run(main._lo_refresh_masterlist("skyrimse"))
        with self.fake([(200, b"not: [a masterlist", "")]):
            meta = run(main._lo_refresh_masterlist("skyrimse", force=True))
        self.assertTrue(meta["error"])
        self.assertEqual(main._lo_masterlist("skyrimse")[0].lookup("Late.esp")["group"], "Late")

    def test_only_loot_urls(self):
        with self.assertRaises(ValueError):
            run(main._lo_http_get("https://example.com/masterlist.yaml"))


class BackendTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(main._LO_DIR, ignore_errors=True)
        main._LO_ML_CACHE.clear()
        st = main._forge_state()
        st.pop("load_order", None)
        main._forge_write(main.FORGE_STATE, st)
        self.plugin = main.Plugin()

        async def offline(url, etag=""):
            raise OSError("offline")
        self.http = mock.patch.object(main, "_LO_HTTP_GET", offline)
        self.http.start()

    def tearDown(self):
        self.http.stop()

    def seed_masterlist(self):
        main._lo_ml_write("skyrimse", {"fetched_at": int(time.time()), "checked_at": int(time.time())},
                          lo.reduce_masterlist(lo.parse_yaml(ML_TEXT.decode())))

    def test_status_and_get(self):
        with FakeGame(GAME_FILES, "*ModA.esp\n*Base.esm\nModB.esp\n"):
            st = run(self.plugin.forge_lo_status(APP, DOMAIN, ""))
            self.assertTrue(st["supported"])
            self.assertEqual(st["counts"]["plugins"], 5)
            self.assertNotIn("entries", st)
            full = run(self.plugin.forge_lo_get(APP, DOMAIN, "", True))
            names = [e["name"] for e in full["entries"]]
            self.assertEqual(names, ["ModA.esp", "Base.esm", "ModB.esp", "Late.esp", "Patch.esp"])
            self.assertEqual(full["implicit"], ["Skyrim.esm", "Update.esm"])
            self.assertFalse(full["masterlist"]["available"])
            self.assertIn("offline", full["masterlist"]["error"])
        self.assertFalse(run(self.plugin.forge_lo_status(22330, "oblivion", ""))["supported"])

    def test_sort_writes_loot_order_and_keeps_pins(self):
        self.seed_masterlist()
        before = "# header\n*Late.esp\n*ModB.esp\n*Patch.esp\n*ModA.esp\n*Base.esm\n"
        with FakeGame(GAME_FILES, before) as g:
            run(self.plugin.forge_lo_pin(APP, "ModB.esp", True, DOMAIN, ""))
            r = run(self.plugin.forge_lo_sort(APP, DOMAIN, ""))
            self.assertTrue(r["ok"], r)
            # Masters first; ModB pinned second; Patch after ModA (header)
            # and after ModB (masterlist); Late in the masterlist's Late group.
            self.assertEqual(g.text(), "# header\n*Base.esm\n*ModB.esp\n*ModA.esp\n*Patch.esp\n*Late.esp\n")
            self.assertTrue(r["masterlist_used"])
            self.assertTrue(os.path.isfile(g.ptxt + main.LOAD_ORDER_BACKUP))
            self.assertTrue([e for e in r["state"]["entries"] if e["name"] == "ModB.esp"][0]["pinned"])
            # Sorting again changes nothing.
            again = run(self.plugin.forge_lo_sort(APP, DOMAIN, ""))
            self.assertEqual(again["moved"], 0)
            # Undo puts the file back.
            run(self.plugin.forge_lo_undo(APP, DOMAIN, ""))
            self.assertEqual(g.text(), before)

    def test_sort_with_a_cycle_writes_nothing(self):
        main._lo_ml_write("skyrimse", {"fetched_at": int(time.time())}, lo.reduce_masterlist(lo.parse_yaml(
            "plugins:\n  - name: 'ModB.esp'\n    after: [ 'Late.esp' ]\n"
            "  - name: 'Late.esp'\n    after: [ 'ModB.esp' ]\n")))
        before = "*Base.esm\n*ModB.esp\n*Late.esp\n"
        with FakeGame(GAME_FILES, before) as g:
            r = run(self.plugin.forge_lo_sort(APP, DOMAIN, ""))
            self.assertFalse(r["ok"])
            self.assertEqual(set(r["cycle"]), {"ModB.esp", "Late.esp"})
            self.assertEqual(g.text(), before)

    def test_writers_refuse_while_the_game_runs(self):
        with FakeGame(GAME_FILES, "*Base.esm\n") as g:
            g.is_running = True
            for call in (self.plugin.forge_lo_sort(APP, DOMAIN, ""),
                         self.plugin.forge_lo_set_active(APP, "ModB.esp", True, DOMAIN, ""),
                         self.plugin.forge_profile_apply_order(APP, "x", DOMAIN, "")):
                r = run(call)
                self.assertFalse(r["ok"])
                self.assertTrue(r.get("running"))
            self.assertEqual(g.text(), "*Base.esm\n")

    def test_hand_order_refuses_what_breaks_a_rule(self):
        with FakeGame(GAME_FILES, "*Base.esm\n*ModA.esp\n*ModB.esp\n*Late.esp\n*Patch.esp\n") as g:
            bad = run(self.plugin.forge_lo_set(APP, ["Base.esm", "Patch.esp", "ModA.esp", "ModB.esp", "Late.esp"],
                                               DOMAIN, ""))
            self.assertFalse(bad["ok"])
            self.assertIn("ModA.esp", bad["error"])
            ok = run(self.plugin.forge_lo_set(APP, ["Base.esm", "ModB.esp", "ModA.esp", "Late.esp", "Patch.esp"],
                                              DOMAIN, ""))
            self.assertTrue(ok["ok"])
            self.assertEqual(g.text(), "*Base.esm\n*ModB.esp\n*ModA.esp\n*Late.esp\n*Patch.esp\n")

    def test_switching_a_plugin_takes_its_masters_and_dependents(self):
        with FakeGame(GAME_FILES, "Base.esm\nModA.esp\n*ModB.esp\nPatch.esp\n") as g:
            r = run(self.plugin.forge_lo_set_active(APP, "Patch.esp", True, DOMAIN, ""))
            self.assertEqual(set(r["also"]), {"ModA.esp", "Base.esm"})
            self.assertIn("*Base.esm", g.text())
            r = run(self.plugin.forge_lo_set_active(APP, "Base.esm", False, DOMAIN, ""))
            self.assertEqual(set(r["also"]), {"ModA.esp", "Patch.esp"})
            self.assertNotIn("*ModA.esp", g.text())

    def test_profile_switch_round_trip(self):
        """Save Full, change everything, save Vanilla+, switch back to Full:
        the mods plan names exactly what to switch and plugins.txt comes back
        byte for byte."""
        full_txt = "*Base.esm\r\n*ModA.esp\r\n*ModB.esp\r\n*Patch.esp\r\nLate.esp\r\n"
        full_mods = [{"folder": "A", "enabled": True}, {"folder": "B", "enabled": True},
                     {"folder": "L", "enabled": False}]
        with FakeGame(GAME_FILES, full_txt) as g:
            self.assertTrue(run(self.plugin.forge_profile_save(APP, "Full modlist", full_mods, DOMAIN, ""))["ok"])
            # The user goes vanilla-ish: two plugins off, the order changed.
            run(self.plugin.forge_lo_set_active(APP, "ModA.esp", False, DOMAIN, ""))
            run(self.plugin.forge_lo_set(APP, ["Base.esm", "Late.esp", "ModA.esp", "ModB.esp", "Patch.esp"],
                                         DOMAIN, ""))
            vanilla_mods = [{"folder": "A", "enabled": False}, {"folder": "B", "enabled": True},
                            {"folder": "L", "enabled": True}]
            run(self.plugin.forge_profile_save(APP, "Vanilla+", vanilla_mods, DOMAIN, ""))
            vanilla_txt = g.text()
            self.assertNotEqual(vanilla_txt, full_txt)
            status = run(self.plugin.forge_lo_status(APP, DOMAIN, ""))
            self.assertEqual(status["profiles"], ["Full modlist", "Vanilla+"])
            self.assertEqual(status["current_profile"], "Vanilla+")

            plan = run(self.plugin.forge_profile_plan(APP, "Full modlist", vanilla_mods, DOMAIN, ""))
            self.assertEqual(plan["changes"], [{"folder": "L", "enabled": False}, {"folder": "A", "enabled": True}])
            self.assertFalse(plan["running"])
            # (The frontend now takes the Ludusavi backup and switches the
            # mods through install.ts; their plugins come and go with them.)
            r = run(self.plugin.forge_profile_apply_order(APP, "Full modlist", DOMAIN, ""))
            self.assertTrue(r["ok"], r)
            self.assertEqual(g.text(), full_txt)
            self.assertEqual(r["state"]["current_profile"], "Full modlist")
            # And back again.
            run(self.plugin.forge_profile_apply_order(APP, "Vanilla+", DOMAIN, ""))
            self.assertEqual(g.text(), vanilla_txt)
            run(self.plugin.forge_profile_delete(APP, "Vanilla+", DOMAIN))
            self.assertEqual(run(self.plugin.forge_lo_status(APP, DOMAIN, ""))["profiles"], ["Full modlist"])

    def test_profile_apply_respects_skips(self):
        with FakeGame(GAME_FILES, "*Base.esm\n*ModA.esp\n*Patch.esp\n") as g:
            run(self.plugin.forge_profile_save(APP, "P", [], DOMAIN, ""))
            main._save_skips(DOMAIN, {"moda.esp": {"reason": "crashes the game", "root": True}})
            try:
                r = run(self.plugin.forge_profile_apply_order(APP, "P", DOMAIN, ""))
                self.assertTrue(any("ModA.esp" in n for n in r["notes"]))
                self.assertNotIn("*ModA.esp", g.text())
                self.assertNotIn("*Patch.esp", g.text())
            finally:
                main._save_skips(DOMAIN, {})

    def test_writers_are_gated(self):
        for name in ("forge_lo_sort", "forge_lo_set", "forge_lo_undo", "forge_lo_set_active",
                     "forge_profile_apply_order"):
            self.assertTrue(getattr(getattr(main.Plugin, name), "__forge_gated__", False), name)


class OblivionRemasteredBackendTests(unittest.TestCase):
    def test_reads_and_writes_in_the_data_folder(self):
        root = tempfile.mkdtemp()
        try:
            game_dir = os.path.join(root, "Oblivion Remastered")
            data = os.path.join(game_dir, *OR["data"].split("/"))
            os.makedirs(data)
            for n, masters, flags in (("Oblivion.esm", [], 1), ("Mod.esp", ["Oblivion.esm"], 0),
                                      ("Off.esp", ["Oblivion.esm"], 0)):
                with open(os.path.join(data, n), "wb") as f:
                    f.write(plugin_bytes(masters, flags, header=20))
            with open(os.path.join(data, "Plugins.txt"), "w", newline="") as f:
                f.write("Mod.esp\r\nOblivion.esm\r\n")

            async def offline(url, etag=""):
                raise OSError("offline")
            with mock.patch.object(main, "_forge_game_dir", lambda *a, **k: game_dir), \
                    mock.patch.object(main, "_LO_HTTP_GET", offline), \
                    mock.patch.object(main, "_process_running", mock.AsyncMock(return_value=False)):
                p = main.Plugin()
                r = run(p.forge_lo_sort(2623190, "oblivionremastered", ""))
                self.assertTrue(r["ok"], r)
                with open(os.path.join(data, "Plugins.txt"), newline="") as f:
                    self.assertEqual(f.read(), "Oblivion.esm\r\nMod.esp\r\n")
                with open(os.path.join(data, "loadorder.txt"), newline="") as f:
                    self.assertEqual(f.read(), "Oblivion.esm\r\nMod.esp\r\nOff.esp\r\n")
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
