"""Cheat sources for ROM games (anygame.73): CTRPF by Title ID, libretro by
system and name, path checks, and staging into Downloads. No network."""
import asyncio
import os
import zipfile
import shutil
import tempfile
import unittest
from unittest import mock

from test_backend import main

import rom_cheats as rc


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


P = "CTRPF-AR-CHEAT-CODES-master/"
NAMES = [P, P + "Cheats/", P + "Cheats/Sonic Lost World (EUR)/",
         P + "Cheats/Sonic Lost World (EUR)/00040000000CB400.txt",
         P + "Cheats/Sonic Lost World (USA)/0004000000079600.txt",
         P + "Cheats/Odd Case (USA)/00040000000b6200.txt",
         P + "README.md"]


def ctrpf_zip(path):
    with zipfile.ZipFile(path, "w") as z:
        for n in NAMES:
            if not n.endswith("/"):
                z.writestr(n, "[Max Lives]\n081E8F44 00000063\n")


class CtrpfTests(unittest.TestCase):
    def test_match_by_title_id_gives_the_region(self):
        got = rc.ctrpf_matches(rc.zip_paths(NAMES), "00040000000CB400")
        self.assertEqual(got, [{"path": "Cheats/Sonic Lost World (EUR)/00040000000CB400.txt",
                                "label": "Sonic Lost World (EUR)", "region": "EUR"}])

    def test_title_id_case_does_not_matter(self):
        self.assertEqual(len(rc.ctrpf_matches(rc.zip_paths(NAMES), "00040000000B6200")), 1)

    def test_no_or_bad_title_id(self):
        self.assertEqual(rc.ctrpf_matches(rc.zip_paths(NAMES), "GALE01"), [])
        self.assertEqual(rc.ctrpf_matches(rc.zip_paths(NAMES), "0004000000000000"), [])


class LibretroTests(unittest.TestCase):
    def test_guesses_start_with_the_rom_files_own_name(self):
        g = rc.libretro_guesses("Super Mario World (USA) (Rev 1).cht", "Super Mario World")
        self.assertEqual(g[0], "Super Mario World (USA) (Rev 1).cht")
        self.assertIn("Super Mario World (USA).cht", g)
        self.assertIn("Super Mario World (Europe).cht", g)
        self.assertLessEqual(len(g), 8)
        self.assertFalse(any("/" in n for n in rc.libretro_guesses("x/y", "A/B")))

    def test_systems(self):
        self.assertEqual(rc.libretro_folder("snes"), "Nintendo - Super Nintendo Entertainment System")
        self.assertEqual(rc.libretro_folder("PSX"), "Sony - PlayStation")
        self.assertEqual(rc.libretro_folder("ps2"), "")


class PathTests(unittest.TestCase):
    def test_only_expected_paths(self):
        self.assertTrue(rc.valid_path("ctrpf", "Cheats/X (USA)/0004000000079600.txt"))
        self.assertTrue(rc.valid_path("libretro", "cht/Sony - PlayStation/Final Fantasy VII (USA) (GameShark).cht"))
        for src, p in [("ctrpf", "Cheats/../x/0004000000079600.txt"), ("ctrpf", "README.md"),
                       ("ctrpf", "Cheats/X/notanid.txt"), ("libretro", "cht/Unknown/x.cht"),
                       ("libretro", "/cht/Sony - PlayStation/x.cht"), ("other", "Cheats/X/0004000000079600.txt")]:
            self.assertFalse(rc.valid_path(src, p), p)

    def test_zip_member_lookup(self):
        self.assertEqual(rc.zip_member(NAMES, "Cheats/Odd Case (USA)/00040000000b6200.txt"),
                         P + "Cheats/Odd Case (USA)/00040000000b6200.txt")
        self.assertEqual(rc.zip_member(NAMES, "Cheats/Nope/0004000000000001.txt"), "")

    def test_raw_url_is_quoted_and_pinned(self):
        url = rc.raw_url("libretro", "cht/Sony - PlayStation/A & B (USA).cht")
        self.assertEqual(url, "https://raw.githubusercontent.com/libretro/libretro-database/master/cht/Sony%20-%20PlayStation/A%20%26%20B%20%28USA%29.cht")
        self.assertTrue(rc.raw_url("ctrpf", "Cheats/X/0004000000079600.txt").startswith(
            "https://raw.githubusercontent.com/JourneyOver/CTRPF-AR-CHEAT-CODES/master/"))

    def test_text_check(self):
        self.assertTrue(rc.looks_like_text_cheats(b"[Max Lives]\n081E8F44 00000063\n"))
        self.assertFalse(rc.looks_like_text_cheats(b"<!DOCTYPE html><html>"))
        self.assertFalse(rc.looks_like_text_cheats(b"PK\x03\x04\x00\x00"))


class GlueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.downloads = os.path.join(self.home, "Downloads")
        os.makedirs(self.downloads)
        main._ROM_STORE = main.rom_mods.RecordStore(os.path.join(self.tmp, "rom.json"))
        self.env = mock.patch.dict(os.environ, {"USERPROFILE": self.home})
        self.env.start()
        self.plugin = main.Plugin()

    def tearDown(self):
        self.env.stop()
        main._ROM_STORE = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_zip(self):
        path = os.path.join(self.tmp, "ctrpf.zip")
        ctrpf_zip(path)

        async def z():
            return path
        return mock.patch.object(main, "_ctrpf_zip", z)

    def test_azahar_sources_by_title_id(self):
        with self.fake_zip():
            r = run(self.plugin.forge_rom_cheat_sources("azahar", "00040000000CB400", "3ds", "Sonic"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["source"], "ctrpf")
        self.assertEqual([c["path"] for c in r["candidates"]], ["Cheats/Sonic Lost World (EUR)/00040000000CB400.txt"])

    def test_azahar_without_title_id_says_so(self):
        r = run(self.plugin.forge_rom_cheat_sources("azahar", "", "3ds", "Sonic"))
        self.assertEqual(r["candidates"], [])
        self.assertIn("Title ID", r["note"])

    def test_retroarch_asks_raw_for_likely_names_only(self):
        asked = []

        async def get(url, limit):
            asked.append(url)
            self.assertTrue(url.startswith("https://raw.githubusercontent.com/libretro/libretro-database/master/cht/"))
            if url.endswith("Super%20Mario%20World%20%28USA%29.cht"):
                return 200, b"cheats = 1\n"
            return 404, b""
        with mock.patch.object(main, "_cheat_get", get):
            r = run(self.plugin.forge_rom_cheat_sources("retroarch", "", "snes", "Super Mario World",
                                                        "Super Mario World (USA) (Rev 1).cht"))
        self.assertEqual([c["path"] for c in r["candidates"]],
                         ["cht/Nintendo - Super Nintendo Entertainment System/Super Mario World (USA).cht"])
        self.assertLessEqual(len(asked), 8)
        self.assertFalse(any("api.github.com" in u for u in asked))

    def test_retroarch_unknown_system(self):
        r = run(self.plugin.forge_rom_cheat_sources("retroarch", "", "ps2", "X"))
        self.assertEqual(r["candidates"], [])

    def test_pcsx2_has_no_fetched_source(self):
        r = run(self.plugin.forge_rom_cheat_sources("pcsx2", "SLUS-20946", "ps2", "X"))
        self.assertEqual((r["source"], r["candidates"]), ("", []))

    def test_stage_ctrpf_from_the_cached_zip_under_its_own_name(self):
        with self.fake_zip():
            r = run(self.plugin.forge_rom_cheat_stage(1, "ctrpf", "Cheats/Sonic Lost World (EUR)/00040000000CB400.txt",
                                                      self.downloads))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["entry"], "00040000000CB400.txt")
        with open(os.path.join(self.downloads, r["entry"]), "rb") as f:
            self.assertIn(b"Max Lives", f.read())
        self.assertIn(r["entry"], main._rom_store().staged())

    def test_stage_libretro_from_raw(self):
        async def get(url, limit):
            return 200, b"cheats = 1\n"
        with mock.patch.object(main, "_cheat_get", get):
            r = run(self.plugin.forge_rom_cheat_stage(
                1, "libretro", "cht/Sony - PlayStation/Final Fantasy VII (USA) (GameShark).cht", self.downloads))
        self.assertEqual(r["entry"], "Final Fantasy VII (USA) (GameShark).cht")

    def test_stage_refuses_odd_paths_web_pages_and_other_folders(self):
        self.assertFalse(run(self.plugin.forge_rom_cheat_stage(1, "ctrpf", "README.md", self.downloads))["ok"])

        async def html(url, limit):
            return 200, b"<!doctype html>"
        with mock.patch.object(main, "_cheat_get", html):
            self.assertFalse(run(self.plugin.forge_rom_cheat_stage(
                1, "libretro", "cht/Sony - PlayStation/X (USA).cht", self.downloads))["ok"])
        other = os.path.join(self.tmp, "x")
        os.makedirs(other)
        self.assertEqual(run(self.plugin.forge_rom_cheat_stage(
            1, "ctrpf", "Cheats/S (EUR)/00040000000CB400.txt", other))["reason"], "downloads_mismatch")
        self.assertEqual(os.listdir(self.downloads), [])

    def test_cheat_records_replace_each_other_on_the_one_file_target(self):
        a = main.rom_mods.make_record({"source": "ctrpf", "file_name": "a.txt", "target_id": "cheats", "kind": "cheatFile"}, 1)
        b = main.rom_mods.make_record({"source": "local", "file_name": "b.txt", "target_id": "cheats", "kind": "cheatFile"}, 2)
        tex = main.rom_mods.make_record({"source": "local", "file_name": "t.zip", "target_id": "textures"}, 3)
        got = main.rom_mods.upsert(main.rom_mods.upsert(main.rom_mods.upsert([], a), tex), b)
        self.assertEqual(sorted(r["file_name"] for r in got), ["b.txt", "t.zip"])


if __name__ == "__main__":
    unittest.main()
