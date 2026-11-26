"""Forge: the anti-cheat lock (refused in the backend, not only hidden), the
way back after a crash, and the cached update counts behind the tile dots."""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from test_backend import main

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
import forge_guard as fg  # noqa: E402


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def reset_forge():
    for p in (main.FORGE_STATE, main.FORGE_UPDATE_CACHE):
        try:
            os.remove(p)
        except OSError:
            pass
    main._FORGE_SCAN_CACHE.clear()


def install_args(domain="eldenring", app_id=1245620, install_dir="ELDEN RING"):
    # install_mod's positional order, as api.ts sends it.
    return (domain, 1, 2, "x.zip", "X", "1.0", install_dir, "mods", "", "", "folder", app_id)


class CatalogTests(unittest.TestCase):
    def test_generated_list_loads_and_has_the_games_that_matter(self):
        cat = fg.load_catalog(main.FORGE_CATALOG)
        self.assertGreater(len(cat), 300)
        for app, product in (("1245620", "Easy Anti-Cheat"), ("553850", "nProtect GameGuard"),
                             ("359550", "BattlEye"), ("1938090", "Ricochet"), ("730", "VAC")):
            self.assertIn(product, cat[app]["anticheats"], app)

    def test_server_side_only_games_are_not_locked(self):
        # Battlefront II (FairFight, server side) is one of the plugin's games.
        cat = fg.load_catalog(main.FORGE_CATALOG)
        self.assertNotIn("1237950", cat)
        self.assertFalse(fg.verdict(1237950, cat, {}, {})["locked"])

    def test_an_unreadable_list_still_has_the_extras(self):
        fg._CATALOG_CACHE.pop("/nope.json", None)
        self.assertIn("730", fg.load_catalog("/nope.json"))


class FolderScanTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_marker_in_the_game_folder(self):
        os.makedirs(os.path.join(self.root, "EasyAntiCheat"))
        self.assertEqual(fg.scan_folder(self.root)["product"], "Easy Anti-Cheat")

    def test_marker_one_level_down(self):
        os.makedirs(os.path.join(self.root, "Game", "BattlEye"))
        hit = fg.scan_folder(self.root)
        self.assertEqual(hit["product"], "BattlEye")
        self.assertTrue(hit["folder"].endswith("Game"))

    def test_case_insensitive_file_marker(self):
        open(os.path.join(self.root, "START_PROTECTED_GAME.EXE"), "w").close()
        self.assertTrue(fg.scan_folder(self.root))

    def test_no_marker(self):
        os.makedirs(os.path.join(self.root, "Data", "Textures"))
        self.assertEqual(fg.scan_folder(self.root), {})
        self.assertEqual(fg.scan_folder(os.path.join(self.root, "missing")), {})


class VerdictTests(unittest.TestCase):
    cat = {"100": {"name": "Shooter", "anticheats": ["BattlEye"]}}

    def test_listed_game_is_locked(self):
        v = fg.verdict(100, self.cat, {}, {})
        self.assertTrue(v["locked"])
        self.assertEqual(v["source"], "list")

    def test_override_unlocks_only_where_allowed(self):
        self.assertFalse(fg.verdict(100, self.cat, {}, {"100": {"at": 1}})["locked"])
        online = {"730": {"name": "CS2", "anticheats": ["VAC"]}}
        v = fg.verdict(730, online, {}, {"730": {"at": 1}})
        self.assertTrue(v["locked"])
        self.assertFalse(v["override_allowed"])

    def test_folder_hit_locks_an_unlisted_game(self):
        v = fg.verdict(5, {}, {"marker": "EasyAntiCheat", "product": "Easy Anti-Cheat"}, {})
        self.assertTrue(v["locked"])
        self.assertEqual(v["source"], "folder")
        self.assertTrue(v["override_allowed"])

    def test_clean_game(self):
        v = fg.verdict(6, {}, {}, {})
        self.assertFalse(v["locked"])
        self.assertFalse(v["detected"])


class BackendLockTests(unittest.TestCase):
    """The lock is enforced by the backend, whatever the frontend shows."""

    def setUp(self):
        reset_forge()
        main._save_settings({"api_key": "test-key", "installed": {}})
        self.plugin = main.Plugin()
        run(self.plugin.forge_register_games([["eldenring", 1245620, "ELDEN RING"],
                                              ["counterstrike2", 730, "Counter-Strike Global Offensive"],
                                              ["fakegame", 999001, "FakeGame"],
                                              ["stardewvalley", 413150, "Stardew Valley"]]))

    def tearDown(self):
        reset_forge()
        shutil.rmtree(os.path.join(main.STEAM_COMMON, "FakeGame"), ignore_errors=True)

    def test_install_is_refused_for_a_listed_game(self):
        r = run(self.plugin.install_mod(*install_args()))
        self.assertFalse(r["ok"])
        self.assertTrue(r["anticheat_locked"])
        self.assertIn("Easy Anti-Cheat", r["error"])

    def test_refused_before_a_restore_point_or_any_file_work(self):
        with mock.patch.object(main, "_rp_create") as rp:
            run(self.plugin.install_mod(*install_args()))
        rp.assert_not_called()

    def test_domain_alone_is_enough(self):
        # app_id 0, as some callers send: the registered domain resolves it.
        r = run(self.plugin.install_mod(*install_args(app_id=0)))
        self.assertTrue(r.get("anticheat_locked"))
        r = run(self.plugin.set_framework_enabled("eldenring", True))
        self.assertTrue(r.get("anticheat_locked"))

    def test_enabling_is_refused_disabling_is_not(self):
        on = run(self.plugin.set_mod_enabled("ELDEN RING", "mods", "SomeMod", True, "folder",
                                             "eldenring", 1245620))
        self.assertTrue(on.get("anticheat_locked"))
        off = run(self.plugin.set_mod_enabled("ELDEN RING", "mods", "SomeMod", False, "folder",
                                              "eldenring", 1245620))
        self.assertFalse(off.get("anticheat_locked"))
        all_off = run(self.plugin.set_all_mods_enabled("ELDEN RING", "mods", False, "folder",
                                                       "eldenring", 1245620))
        self.assertFalse(all_off.get("anticheat_locked"))

    def test_override_needs_the_confirmation_and_then_unlocks(self):
        r = run(self.plugin.forge_set_anticheat_override(1245620, True, ""))
        self.assertFalse(r["ok"])
        self.assertTrue(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))
        r = run(self.plugin.forge_set_anticheat_override(1245620, True, fg.OVERRIDE_ACK))
        self.assertTrue(r["ok"])
        self.assertFalse(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))
        st = run(self.plugin.forge_game_status(1245620, "eldenring", ""))["anticheat"]
        self.assertTrue(st["detected"])
        self.assertTrue(st["override_on"])
        self.assertFalse(st["locked"])
        run(self.plugin.forge_set_anticheat_override(1245620, False, ""))
        self.assertTrue(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))

    def test_online_only_games_have_no_override(self):
        r = run(self.plugin.forge_set_anticheat_override(730, True, fg.OVERRIDE_ACK))
        self.assertFalse(r["ok"])
        r = run(self.plugin.install_mod(*install_args("counterstrike2", 730, "Counter-Strike Global Offensive")))
        self.assertTrue(r.get("anticheat_locked"))

    def test_anti_cheat_files_lock_a_game_no_list_knows(self):
        os.makedirs(os.path.join(main.STEAM_COMMON, "FakeGame", "EasyAntiCheat"), exist_ok=True)
        r = run(self.plugin.install_mod(*install_args("fakegame", 999001, "FakeGame")))
        self.assertTrue(r.get("anticheat_locked"))
        st = run(self.plugin.forge_game_status(999001, "fakegame", "FakeGame"))["anticheat"]
        self.assertEqual(st["source"], "folder")
        self.assertEqual(st["marker"], "EasyAntiCheat")

    def test_a_game_without_anti_cheat_is_untouched(self):
        r = run(self.plugin.install_mod(*install_args("stardewvalley", 413150, "Stardew Valley")))
        self.assertFalse(r.get("anticheat_locked"))

    def test_every_gated_method_exists(self):
        # A rename upstream would silently drop the gate on that path.
        for name in main._FORGE_GATED:
            self.assertTrue(hasattr(main.Plugin, name), name)

    def test_gate_keeps_the_signature(self):
        import inspect
        params = list(inspect.signature(main.Plugin.set_mod_enabled).parameters)
        self.assertEqual(params[:5], ["self", "install_dir", "mods_subdir", "folder", "enabled"])


class GuardRuleTests(unittest.TestCase):
    A = {"A": True}
    AB = {"A": True, "B": True}

    def clean(self, st, mods, t):
        st = fg.on_launch(st, mods, t)
        st, ev = fg.on_exit(st, t + 600)
        self.assertEqual(ev, "clean")
        return st

    def quick(self, st, mods, t, crashed=False, seconds=20):
        st = fg.on_launch(st, mods, t)
        return fg.on_exit(st, t + seconds, crashed)

    def test_two_quick_exits_after_a_change_make_one_offer(self):
        st = self.clean({}, self.A, 0)
        st, ev = self.quick(st, self.AB, 1000)
        self.assertEqual(ev, "failed")
        st, ev = self.quick(st, self.AB, 2000)
        self.assertEqual(ev, "offer")
        self.assertTrue(st["offer"])
        st, ev = self.quick(st, self.AB, 3000)
        self.assertEqual(ev, "failed")  # already offered: no second notification

    def test_a_long_run_that_crashed_counts(self):
        st = self.clean({}, self.A, 0)
        st, _ = self.quick(st, self.AB, 1000, crashed=True, seconds=900)
        st, ev = self.quick(st, self.AB, 3000, crashed=True, seconds=900)
        self.assertEqual(ev, "offer")

    def test_the_threshold_is_sixty_seconds(self):
        st = self.clean({}, self.A, 0)
        st, ev = self.quick(st, self.AB, 1000, seconds=fg.QUICK_EXIT_SECONDS)
        self.assertEqual(ev, "clean")
        self.assertEqual(st["lkg"]["set"], self.AB)

    def test_a_clean_run_between_failures_resets_the_streak(self):
        st = self.clean({}, self.A, 0)
        st, _ = self.quick(st, self.AB, 1000)
        st = self.clean(st, self.AB, 2000)
        st, ev = self.quick(st, {"A": True, "B": True, "C": True}, 4000)
        self.assertEqual(ev, "failed")
        self.assertEqual(st["fails"], 1)

    def test_changing_mods_again_starts_a_new_streak(self):
        st = self.clean({}, self.A, 0)
        st, _ = self.quick(st, self.AB, 1000)
        st, ev = self.quick(st, {"A": True, "C": True}, 2000)
        self.assertEqual(ev, "failed")
        self.assertEqual(st["fails"], 1)

    def test_failures_with_the_good_mods_are_not_blamed_on_mods(self):
        st = self.clean({}, self.A, 0)
        for t in (1000, 2000, 3000):
            st, ev = self.quick(st, self.A, t)
            self.assertEqual(ev, "failed")
        self.assertFalse(st.get("offer"))

    def test_a_double_start_announcement_keeps_the_first_start(self):
        st = fg.on_launch({}, self.A, 100)
        st = fg.on_launch(st, self.A, 105)
        self.assertEqual(st["session"]["started"], 100)

    def test_exit_without_a_session_is_ignored(self):
        st, ev = fg.on_exit({}, 50)
        self.assertEqual(ev, "")

    def test_restore_plan_only_switches_never_removes(self):
        st = self.clean({}, {"A": True, "B": False, "Gone": True}, 0)
        plan = fg.restore_plan(st, {"A": False, "B": True, "New": True})
        self.assertEqual(plan["changes"], [{"folder": "A", "enabled": True},
                                           {"folder": "B", "enabled": False},
                                           {"folder": "New", "enabled": False}])
        self.assertEqual(plan["missing"], ["Gone"])
        self.assertFalse(plan["vanilla"])

    def test_without_a_clean_run_the_way_back_is_all_off(self):
        st, _ = self.quick({}, self.AB, 0)
        st, ev = self.quick(st, self.AB, 100)
        self.assertEqual(ev, "offer")
        plan = fg.restore_plan(st, self.AB)
        self.assertTrue(plan["vanilla"])
        self.assertEqual([c["enabled"] for c in plan["changes"]], [False, False])

    def test_restore_is_reversible(self):
        st = self.clean({}, self.A, 0)
        st = fg.after_restore(st, self.AB, 5000)
        self.assertFalse(st["offer"])
        undo = fg.undo_plan(st, {"A": True, "B": False}, 6000)
        self.assertEqual(undo["changes"], [{"folder": "B", "enabled": True}])
        self.assertFalse(fg.undo_plan(st, {}, 5000 + fg.UNDO_SECONDS + 1)["available"])


class WerTests(unittest.TestCase):
    def test_a_crash_report_during_the_run_is_found(self):
        root = tempfile.mkdtemp()
        try:
            name = "AppCrash_eldenring.exe_1a2b3c_d4e5f6_cab_0123"
            os.makedirs(os.path.join(root, name))
            os.makedirs(os.path.join(root, "AppCrash_notepad.exe_ff_ee_cab_1"))
            now = os.path.getmtime(os.path.join(root, name))
            self.assertEqual(fg.wer_crashed(["eldenring.exe"], now - 30, now + 1, [root]), name)
            self.assertEqual(fg.wer_crashed(["eldenring"], now + 600, now + 900, [root]), "")
            self.assertEqual(fg.wer_crashed(["other.exe"], now - 30, now + 1, [root]), "")
            self.assertEqual(fg.wer_crashed([], now - 30, now + 1, [root]), "")
        finally:
            shutil.rmtree(root, ignore_errors=True)


class GuardBackendTests(unittest.TestCase):
    def setUp(self):
        reset_forge()
        self.plugin = main.Plugin()
        self.clock = [1000.0]
        self.patch = mock.patch.object(main.time, "time", lambda: self.clock[0])
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        reset_forge()

    def launch_exit(self, mods, seconds):
        run(self.plugin.forge_guard_launch(42, "game", mods))
        self.clock[0] += seconds
        r = run(self.plugin.forge_guard_exit(42, "", ""))
        self.clock[0] += 100
        return r

    def test_one_notification_then_restore_and_undo(self):
        self.assertEqual(self.launch_exit({"A": True}, 900)["event"], "clean")
        self.assertFalse(self.launch_exit({"A": True, "B": True}, 10)["notify"])
        r = self.launch_exit({"A": True, "B": True}, 10)
        self.assertEqual(r["event"], "offer")
        self.assertTrue(r["notify"])
        status = run(self.plugin.forge_game_status(42, "game", ""))["guard"]
        self.assertTrue(status["offer"])
        plan = run(self.plugin.forge_guard_plan(42, {"A": True, "B": True}, "restore"))
        self.assertEqual(plan["changes"], [{"folder": "B", "enabled": False}])
        run(self.plugin.forge_guard_restored(42, {"A": True, "B": True}))
        status = run(self.plugin.forge_game_status(42, "game", ""))["guard"]
        self.assertFalse(status["offer"])
        self.assertTrue(status["undo"])
        undo = run(self.plugin.forge_guard_plan(42, {"A": True, "B": False}, "undo"))
        self.assertEqual(undo["changes"], [{"folder": "B", "enabled": True}])
        run(self.plugin.forge_guard_undone(42))
        self.assertFalse(run(self.plugin.forge_game_status(42, "game", ""))["guard"]["undo"])

    def test_dismiss_clears_the_offer(self):
        self.launch_exit({"A": True}, 900)
        self.launch_exit({"B": True}, 5)
        self.launch_exit({"B": True}, 5)
        run(self.plugin.forge_guard_dismiss(42))
        self.assertFalse(run(self.plugin.forge_game_status(42, "game", ""))["guard"]["offer"])


class UpdateDotTests(unittest.TestCase):
    def setUp(self):
        reset_forge()
        recs = {"A": {"mod_id": 1, "version": "1.0"}, "B": {"mod_id": 2, "version": "2.0"},
                "Pinned": {"mod_id": 3, "version": "1.0", "source": "collection"},
                "Half": {"mod_id": 4, "version": "1.0", "source": "companion"},
                "Ignored": {"mod_id": 5, "version": "1.0", "ignore_update": "1.5"}}
        main._save_settings({"api_key": "test-key", "installed": {"g1": recs, "g2": dict(recs),
                                                                   "g3": dict(recs), "g4": dict(recs),
                                                                   "empty": {}}})
        self.plugin = main.Plugin()
        self.calls = []

        async def fake_batches(game_id, ids, fields, api_key=None):
            self.calls.append(game_id)
            return [{"modId": 1, "version": "1.1"}, {"modId": 2, "version": "2.0"},
                    {"modId": 3, "version": "9"}, {"modId": 4, "version": "9"},
                    {"modId": 5, "version": "1.5"}]

        async def fake_game_id(domain, api_key=None):
            return domain

        self.patches = [mock.patch.object(main, "_legacy_mods_in_batches", fake_batches),
                        mock.patch.object(main, "_resolve_game_id", fake_game_id)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        reset_forge()

    def test_counts_follow_the_update_rules(self):
        main._forge_store_versions("g1", [{"modId": 1, "version": "1.1"}, {"modId": 3, "version": "9"},
                                          {"modId": 4, "version": "9"}, {"modId": 5, "version": "1.5"}])
        r = run(self.plugin.forge_update_dots(["g1"], False))
        self.assertEqual(r["games"]["g1"]["folders"], ["A"])
        self.assertEqual(self.calls, [])  # no refresh asked: no network

    def test_refresh_is_capped_spaced_and_cached(self):
        r = run(self.plugin.forge_update_dots(["g1", "g2", "g3", "g4", "empty"], True))
        self.assertEqual(len(r["refreshed"]), fg.REFRESH_PER_CALL)
        self.assertNotIn("empty", self.calls)
        # Straight away again: spacing holds, nothing fetched.
        r = run(self.plugin.forge_update_dots(["g1", "g2", "g3", "g4"], True))
        self.assertEqual(r["refreshed"], [])
        # Later: only the game still missing is fetched; the rest are fresh.
        cache = main._forge_read(main.FORGE_UPDATE_CACHE)
        cache["last_net"] = 0
        main._forge_write(main.FORGE_UPDATE_CACHE, cache)
        r = run(self.plugin.forge_update_dots(["g1", "g2", "g3", "g4"], True))
        self.assertEqual(r["refreshed"], ["g4"])
        self.assertEqual(r["games"]["g4"]["count"], 1)

    def test_a_finished_update_clears_the_dot_without_asking_nexus(self):
        main._forge_store_versions("g1", [{"modId": 1, "version": "1.1"}])
        s = main._load_settings()
        s["installed"]["g1"]["A"]["version"] = "1.1"
        main._save_settings(s)
        self.assertEqual(run(self.plugin.forge_update_dots(["g1"], False))["games"]["g1"]["count"], 0)

    def test_the_updates_page_check_fills_the_cache(self):
        r = run(self.plugin.check_updates("g1", []))
        self.assertTrue(r["ok"])
        dots = run(self.plugin.forge_update_dots(["g1"], False))
        self.assertEqual(dots["games"]["g1"]["folders"], ["A"])
        self.assertEqual(len(self.calls), 1)

    def test_no_key_no_network(self):
        s = main._load_settings()
        s.pop("api_key")
        main._save_settings(s)
        r = run(self.plugin.forge_update_dots(["g1"], True))
        self.assertEqual(r["refreshed"], [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
