"""Forge for ROM games (The Collector) and the rest of the library: platform
mapping, GameBanana ranking, staging into Downloads (entry names only), the
ROM mod records, Nexus updates, non-Steam shortcut folders and the controller
folder picker. Nothing touches the network."""
import asyncio
import os
import shutil
import tempfile
import unittest
import zipfile
from unittest import mock

from test_backend import main

import rom_mods as rm


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class PlatformTests(unittest.TestCase):
    def test_common_systems_are_mapped(self):
        for slug, name in [("ngc", "GameCube"), ("wii", "Wii"), ("wiiu", "Wii U"), ("switch", "Switch"),
                           ("ps2", "PlayStation 2"), ("psp", "PSP"), ("ps3", "PlayStation 3"),
                           ("3ds", "3DS"), ("n64", "Nintendo 64"), ("snes", "SNES"),
                           ("gba", "Game Boy Advance"), ("nds", "DS"), ("psx", "PlayStation"),
                           ("genesis-slash-megadrive", "Genesis"), ("dc", "Dreamcast")]:
            info = rm.platform_info(slug)
            self.assertTrue(info["mapped"], slug)
            self.assertEqual(info["name"], name, slug)

    def test_case_and_aliases(self):
        self.assertEqual(rm.platform_info("NGC")["name"], "GameCube")
        self.assertEqual(rm.platform_info("gamecube")["name"], "GameCube")

    def test_unmapped_slug_is_reported_not_guessed(self):
        info = rm.platform_info("arcade")
        self.assertFalse(info["mapped"])
        self.assertEqual(info["name"], "")
        for slug in rm.UNMAPPED_EXAMPLES:
            self.assertFalse(rm.platform_info(slug)["mapped"], slug)


class MatchTests(unittest.TestCase):
    def test_region_tags_are_dropped(self):
        self.assertEqual(rm.clean_rom_name("Super Mario Sunshine (USA) (Rev 1)"), "Super Mario Sunshine")
        self.assertEqual(rm.clean_rom_name("Zelda [!]"), "Zelda")

    def test_queries_add_the_platform_only_when_mapped(self):
        self.assertEqual(rm.search_queries("Metroid Prime (USA)", "ngc"), ["Metroid Prime", "Metroid Prime GameCube"])
        self.assertEqual(rm.search_queries("Pac-Man", "arcade"), ["Pac-Man"])

    def test_same_title_with_this_platform_wins(self):
        cands = [{"id": 1, "name": "Sonic Adventure 2 (Dreamcast)"}, {"id": 2, "name": "Sonic Adventure 2 (GC)"},
                 {"id": 3, "name": "Sonic Adventure 2 Battle"}]
        ranked = rm.rank_candidates("Sonic Adventure 2 (USA)", "ngc", cands)
        self.assertEqual(ranked[0]["id"], 2)
        self.assertTrue(ranked[0]["platform_match"])
        self.assertEqual(rm.auto_pick(ranked)["id"], 2)
        dc = next(c for c in ranked if c["id"] == 1)
        self.assertEqual(dc["score"], 40)  # another system: kept, ranked low

    def test_platform_word_at_the_end_counts(self):
        ranked = rm.rank_candidates("Mario Kart Wii", "wii", [{"id": 5, "name": "Mario Kart Wii"}])
        self.assertEqual(ranked[0]["score"], 100)

    def test_a_plain_exact_title_links_by_itself(self):
        ranked = rm.rank_candidates("Super Mario Sunshine", "ngc", [{"id": 7, "name": "Super Mario Sunshine"},
                                                                   {"id": 8, "name": "Super Mario Galaxy"}])
        self.assertEqual(rm.auto_pick(ranked)["id"], 7)

    def test_two_equal_best_need_the_user(self):
        ranked = rm.rank_candidates("Tetris", "gb", [{"id": 1, "name": "Tetris"}, {"id": 2, "name": "Tetris"}])
        self.assertIsNone(rm.auto_pick(ranked))  # duplicate names, two ids

    def test_no_exact_title_needs_the_user(self):
        ranked = rm.rank_candidates("Zelda Wind Waker", "ngc", [{"id": 1, "name": "The Legend of Zelda: The Wind Waker"}])
        self.assertIsNone(rm.auto_pick(ranked))
        self.assertEqual(len(ranked), 1)

    def test_duplicates_are_dropped(self):
        ranked = rm.rank_candidates("X", "", [{"id": 1, "name": "X"}, {"id": 1, "name": "X"}, {"name": "no id"}])
        self.assertEqual([c["id"] for c in ranked], [1])


class StagingNameTests(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(rm.stage_kind("pack.ZIP"), "zip")
        self.assertEqual(rm.stage_kind("fix.bps"), "patch")
        self.assertEqual(rm.stage_kind("pack.7z"), "extract")
        self.assertEqual(rm.stage_kind("pack.rar"), "extract")
        self.assertEqual(rm.stage_kind("0004000000055D00.TXT"), "cheat")
        self.assertEqual(rm.stage_kind("game.pnach"), "cheat")
        self.assertEqual(rm.stage_kind("game.cht"), "cheat")
        self.assertEqual(rm.stage_entry_name("x", "g.pnach", []), "g.pnach")

    def test_entry_names_are_the_archives_own_and_unique(self):
        self.assertEqual(rm.stage_entry_name("HD", "HD Textures v2.zip", []), "HD Textures v2.zip")
        self.assertEqual(rm.stage_entry_name("HD", "pack.zip", ["PACK.zip"]), "pack (2).zip")
        self.assertEqual(rm.stage_entry_name("HD", "pack.zip", ["pack.zip", "pack (2).zip"]), "pack (3).zip")
        self.assertEqual(rm.stage_entry_name("HD", "pack.7z", []), "pack")
        self.assertEqual(rm.stage_entry_name("Fix", "fix.IPS", []), "fix.ips")
        self.assertEqual(rm.stage_entry_name("Fix", "a:b?.zip", []), "a b.zip")
        self.assertEqual(rm.stage_entry_name("Named", "", []), "Named")
        self.assertEqual(rm.stage_entry_name("x", "CON.zip", []), "_CON.zip")
        self.assertEqual(rm.safe_entry_base("..."), "mod")
        self.assertEqual(rm.stage_entry_name("x", "dir/sub/pack.zip", []), "pack.zip")

    def test_entry_name_check(self):
        self.assertTrue(rm.is_entry_name("Forge - HD.zip"))
        for bad in ("", ".", "..", "a/b", "a\\b", "C:x", " x"):
            self.assertFalse(rm.is_entry_name(bad), bad)

    def test_same_folder(self):
        self.assertTrue(rm.same_folder("C:/Users/V/Downloads/", "c:\\users\\v\\downloads"))
        self.assertFalse(rm.same_folder("C:/Users/V/Downloads", "C:/Users/V/Desktop"))
        self.assertFalse(rm.same_folder("", ""))


class RecordTests(unittest.TestCase):
    def test_make_record_keeps_only_entry_names(self):
        rec = rm.make_record({"source": "gamebanana", "mod_id": 1000000005, "file_id": 1000000009,
                              "target_id": "dolphin-textures", "entries": ["GALE01", "../x", "ok.png"],
                              "name": "HD"}, 100)
        self.assertEqual(rec["entries"], ["GALE01", "ok.png"])
        self.assertEqual(rec["id"], "gamebanana:1000000005:1000000009:dolphin-textures")
        with self.assertRaises(ValueError):
            rm.make_record({"source": "web"}, 0)

    def test_update_replaces_the_same_mod_on_the_same_target(self):
        a = rm.make_record({"source": "nexus", "mod_id": 3, "file_id": 1, "target_id": "t"}, 1)
        b = rm.make_record({"source": "nexus", "mod_id": 3, "file_id": 2, "target_id": "t"}, 2)
        c = rm.make_record({"source": "nexus", "mod_id": 3, "file_id": 2, "target_id": "other"}, 2)
        got = rm.upsert(rm.upsert(rm.upsert([], a), b), c)
        self.assertEqual([(r["file_id"], r["target_id"]) for r in got], [(2, "t"), (2, "other")])

    def test_new_entries(self):
        self.assertEqual(rm.new_entries(["A", "b"], ["a", "B", "C"]), ["C"])

    def test_store_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            st = rm.RecordStore(os.path.join(d, "x", "rom.json"))
            rec = rm.make_record({"source": "local", "file_name": "pack.zip", "target_id": "t"}, 5)
            st.put(3000000001, rec)
            self.assertEqual(st.records(3000000001)[0]["id"], "local:pack.zip:t")
            st.link(3000000001, "nexus", {"domain": "metroidprime"})
            self.assertEqual(st.link(3000000001, "nexus")["domain"], "metroidprime")
            st.link(3000000001, "nexus", clear=True)
            self.assertIsNone(st.link(3000000001, "nexus"))
            st.forget(3000000001, rec["id"])
            self.assertEqual(st.records(3000000001), [])
            st.note_staged("Forge - A.zip")
            self.assertEqual(st.staged(), ["Forge - A.zip"])
            st.note_staged("Forge - A.zip", add=False)
            self.assertEqual(st.staged(), [])


class NexusUpdateTests(unittest.TestCase):
    FILES = [
        {"file_id": 1, "uploaded_timestamp": 1000, "category_name": "MAIN", "version": "1.0"},
        {"file_id": 2, "uploaded_timestamp": 5000, "category_name": "MAIN", "version": "1.1"},
        {"file_id": 3, "uploaded_timestamp": 9000, "category_name": "OLD_VERSION", "version": "0.9"},
    ]

    def test_newer_main_file(self):
        self.assertEqual(rm.nexus_update_for({"file_id": 1}, self.FILES)["file_id"], 2)

    def test_newest_installed_has_none(self):
        self.assertIsNone(rm.nexus_update_for({"file_id": 2}, self.FILES))

    def test_sibling_uploads_are_not_updates(self):
        files = [{"file_id": 1, "uploaded_timestamp": 1000, "category_name": "MAIN"},
                 {"file_id": 2, "uploaded_timestamp": 1060, "category_name": "MAIN"}]
        self.assertIsNone(rm.nexus_update_for({"file_id": 1}, files))


class StageGlueTests(unittest.TestCase):
    """forge_rom_stage: downloads into Forge's cache, then into the Downloads
    folder The Collector listed, and answers with an entry NAME."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.downloads = os.path.join(self.home, "Downloads")
        os.makedirs(self.downloads)
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        main._ROM_STORE = main.rom_mods.RecordStore(os.path.join(self.tmp, "rom.json"))
        self.env = mock.patch.dict(os.environ, {"USERPROFILE": self.home})
        self.env.start()
        self.plugin = main.Plugin()

    def tearDown(self):
        self.env.stop()
        main._ROM_STORE = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_download(self, name):
        path = os.path.join(self.cache, name)

        async def dl(domain, mod_id, file_id, file_name, api_key, *a, **k):
            if name.endswith(".zip"):
                with zipfile.ZipFile(path, "w") as z:
                    z.writestr("GALE01/tex.png", b"x")
            else:
                with open(path, "wb") as f:
                    f.write(b"data")
            return "", path
        return dl

    def test_zip_is_copied_under_forge_name(self):
        with mock.patch.object(main, "_download_archive", self.fake_download("a.zip")):
            r = run(self.plugin.forge_rom_stage(3000000001, "gamebanana", 1000000005, 1000000009, "pack.zip",
                                                "HD Pack", self.downloads))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["entry"], "pack.zip")
        self.assertNotIn(os.sep, r["entry"])
        self.assertTrue(os.path.isfile(os.path.join(self.downloads, r["entry"])))
        self.assertIn(r["entry"], main._rom_store().staged())

    def test_other_archives_are_unpacked_into_a_folder(self):
        async def extract(archive, dest):
            os.makedirs(os.path.join(dest, "GALE01"), exist_ok=True)
            with open(os.path.join(dest, "GALE01", "t.png"), "wb") as f:
                f.write(b"x")
            return ""
        with mock.patch.object(main, "_download_archive", self.fake_download("a.7z")), \
                mock.patch.object(main, "_extract_archive", extract):
            r = run(self.plugin.forge_rom_stage(1, "nexus", 55, 66, "pack.7z", "Pack", self.downloads, "metroidprime"))
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["entry"], r["kind"]), ("pack", "folder"))
        self.assertTrue(os.path.isfile(os.path.join(self.downloads, "pack", "GALE01", "t.png")))

    def test_a_taken_name_is_never_reused(self):
        open(os.path.join(self.downloads, "pack.zip"), "wb").close()
        with mock.patch.object(main, "_download_archive", self.fake_download("a.zip")):
            r = run(self.plugin.forge_rom_stage(1, "gamebanana", 1000000005, 1000000009, "pack.zip", "P", self.downloads))
        self.assertEqual(r["entry"], "pack (2).zip")
        self.assertEqual(os.path.getsize(os.path.join(self.downloads, "pack.zip")), 0, "the user's file is untouched")

    def test_a_folder_that_is_not_the_users_downloads_is_refused(self):
        other = os.path.join(self.tmp, "elsewhere")
        os.makedirs(other)
        with mock.patch.object(main, "_download_archive", self.fake_download("a.zip")) as _:
            r = run(self.plugin.forge_rom_stage(1, "gamebanana", 1000000005, 1000000009, "a.zip", "A", other))
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "downloads_mismatch")
        self.assertEqual(os.listdir(other), [])

    def test_wrong_source_ids_are_refused(self):
        self.assertFalse(run(self.plugin.forge_rom_stage(1, "gamebanana", 5, 9, "a.zip", "A", self.downloads))["ok"])
        self.assertFalse(run(self.plugin.forge_rom_stage(1, "nexus", 5, 9, "a.zip", "A", self.downloads, ""))["ok"])
        self.assertFalse(run(self.plugin.forge_rom_stage(1, "web", 5, 9, "a.zip", "A", self.downloads))["ok"])

    def test_unstage_removes_only_what_forge_staged(self):
        mine = os.path.join(self.downloads, "A.zip")
        theirs = os.path.join(self.downloads, "B.zip")
        for p in (mine, theirs):
            open(p, "wb").close()
        main._rom_store().note_staged("A.zip")
        self.assertTrue(run(self.plugin.forge_rom_unstage("A.zip", self.downloads))["ok"])
        self.assertFalse(os.path.exists(mine))
        self.assertFalse(run(self.plugin.forge_rom_unstage("B.zip", self.downloads))["ok"])
        self.assertTrue(os.path.exists(theirs))
        self.assertFalse(run(self.plugin.forge_rom_unstage("../x", self.downloads))["ok"])

    def test_records_round_trip(self):
        r = run(self.plugin.forge_rom_record(3000000001, {"source": "gamebanana", "mod_id": 1000000005,
                                                          "file_id": 1000000009, "target_id": "t",
                                                          "entries": ["GALE01"], "name": "HD"}))
        self.assertTrue(r["ok"])
        mods = run(self.plugin.forge_rom_mods(3000000001))["mods"]
        self.assertEqual(len(mods), 1)
        self.assertEqual(run(self.plugin.forge_rom_forget(3000000001, mods[0]["id"]))["mods"], [])
        self.assertFalse(run(self.plugin.forge_rom_record(1, {"source": "x"}))["ok"])

    def test_nexus_link(self):
        self.assertFalse(run(self.plugin.forge_rom_set_nexus(1, "Bad Domain!"))["ok"])
        self.assertEqual(run(self.plugin.forge_rom_set_nexus(1, "metroidprime", "Metroid Prime"))["linked"]["domain"],
                         "metroidprime")
        self.assertIsNone(run(self.plugin.forge_rom_set_nexus(1, ""))["linked"])


class LibraryGapTests(unittest.TestCase):
    """Non-Steam shortcuts and games Steam has no manifest for."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.plugin = main.Plugin()
        self.settings = {}
        self.p1 = mock.patch.object(main, "_load_settings", lambda: self.settings)
        self.p2 = mock.patch.object(main, "_save_settings", lambda s: self.settings.update(s))
        self.p1.start()
        self.p2.start()

    def tearDown(self):
        self.p1.stop()
        self.p2.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_shortcut_without_a_folder_asks_for_one(self):
        r = self.plugin._experimental_install(3000000001)
        self.assertTrue(r["needsFolder"])
        self.assertEqual(r["installDir"], "")

    def test_the_shortcut_start_folder_is_used(self):
        game = os.path.join(self.tmp, "MyGame")
        os.makedirs(game)
        r = self.plugin._experimental_install(3000000001, game)
        self.assertEqual(r["installDir"], os.path.normpath(game))
        self.assertEqual(main._game_dir(r["installDir"]), os.path.normpath(game))

    def test_a_relative_hint_is_ignored(self):
        self.assertTrue(self.plugin._experimental_install(3000000001, "MyGame")["needsFolder"])

    def test_the_picked_folder_is_remembered(self):
        game = os.path.join(self.tmp, "Picked")
        os.makedirs(game)
        r = run(self.plugin.set_game_folder(3000000001, game))
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.plugin._experimental_install(3000000001)["installDir"], os.path.normpath(game))

    def test_a_drive_root_or_missing_folder_is_refused(self):
        self.assertFalse(run(self.plugin.set_game_folder(3000000001, os.path.join(self.tmp, "nope")))["ok"])
        self.assertFalse(run(self.plugin.set_game_folder(3000000001, os.path.abspath(os.sep)))["ok"])
        self.assertFalse(run(self.plugin.set_game_folder(3000000001, "relative"))["ok"])

    def test_no_nexus_setup_uses_a_local_domain(self):
        game = os.path.join(self.tmp, "Indie")
        os.makedirs(game)
        self.settings["forge_game_folders"] = {"3000000002": game}
        with mock.patch.object(main.Plugin, "_experimental_framework") as fw:
            r = run(self.plugin.save_experimental_game(3000000002, "Indie", "", ""))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["game"]["nexusDomain"], "local-3000000002")
        self.assertTrue(r["game"]["noNexus"])
        fw.assert_not_called()

    def test_setup_without_a_folder_is_refused(self):
        r = run(self.plugin.save_experimental_game(3000000003, "X", "somegame", "Some Game"))
        self.assertFalse(r["ok"])
        self.assertTrue(r["needsFolder"])

    def test_folder_listing(self):
        os.makedirs(os.path.join(self.tmp, "b"))
        os.makedirs(os.path.join(self.tmp, "A"))
        os.makedirs(os.path.join(self.tmp, ".hidden"))
        open(os.path.join(self.tmp, "file.txt"), "w").close()
        r = run(self.plugin.forge_list_folders(self.tmp))
        self.assertEqual(r["folders"], ["A", "b"])
        self.assertEqual(r["parent"], os.path.dirname(self.tmp))
        roots = run(self.plugin.forge_list_folders(""))
        self.assertTrue(roots["folders"])
        self.assertFalse(run(self.plugin.forge_list_folders(os.path.join(self.tmp, "missing")))["ok"])


if __name__ == "__main__":
    unittest.main()
