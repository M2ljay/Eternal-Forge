"""Forge: the anti-cheat lock (refused in the backend, not only hidden), the
way back after a crash, and the cached update counts behind the tile dots."""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from test_backend import main, real_forge_resolver

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

    def test_every_locked_game_offers_the_override(self):
        self.assertFalse(fg.verdict(100, self.cat, {}, {"100": {"at": 1}})["locked"])
        online = {"730": {"name": "CS2", "anticheats": ["VAC"]}}
        v = fg.verdict(730, online, {}, {})
        self.assertTrue(v["locked"])
        self.assertTrue(v["override_allowed"])
        self.assertEqual(v["risk"], "ban")
        self.assertTrue(v["online_only"])
        self.assertFalse(fg.verdict(730, online, {}, {"730": {"at": 1}})["locked"])

    def test_risk_wording_follows_offline_modes(self):
        er = {"1245620": {"name": "Elden Ring", "anticheats": ["Easy Anti-Cheat"]}}
        self.assertEqual(fg.verdict(1245620, er, {}, {})["risk"], "offline")
        self.assertEqual(fg.verdict(100, self.cat, {}, {})["risk"], "ban")

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
        self.real = real_forge_resolver()
        self.real.start()
        main._save_settings({"api_key": "test-key", "installed": {}})
        self.plugin = main.Plugin()
        run(self.plugin.forge_register_games([["eldenring", 1245620, "ELDEN RING"],
                                              ["counterstrike2", 730, "Counter-Strike Global Offensive"],
                                              ["fakegame", 999001, "FakeGame"],
                                              ["stardewvalley", 413150, "Stardew Valley"]]))

    def tearDown(self):
        self.real.stop()
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

    def test_one_call_unlocks_and_the_flag_is_what_the_gate_reads(self):
        self.assertTrue(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))
        r = run(self.plugin.forge_set_anticheat_override(1245620, True, ""))
        self.assertTrue(r["ok"])
        self.assertFalse(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))
        st = run(self.plugin.forge_game_status(1245620, "eldenring", ""))["anticheat"]
        self.assertTrue(st["detected"])
        self.assertTrue(st["override_on"])
        self.assertFalse(st["locked"])
        run(self.plugin.forge_set_anticheat_override(1245620, False, ""))
        self.assertTrue(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))

    def test_online_only_games_can_be_bypassed_too(self):
        args = install_args("counterstrike2", 730, "Counter-Strike Global Offensive")
        self.assertTrue(run(self.plugin.install_mod(*args)).get("anticheat_locked"))
        self.assertTrue(run(self.plugin.forge_set_anticheat_override(730, True, ""))["ok"])
        self.assertFalse(run(self.plugin.install_mod(*args)).get("anticheat_locked"))
        run(self.plugin.forge_set_anticheat_override(730, False, ""))
        self.assertTrue(run(self.plugin.install_mod(*args)).get("anticheat_locked"))

    def test_a_game_without_anti_cheat_has_nothing_to_bypass(self):
        self.assertFalse(run(self.plugin.forge_set_anticheat_override(413150, True, ""))["ok"])

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


class EveryEnablePathTests(BackendLockTests):
    """F1: every path that installs or switches mods on is gated, including
    the ones whose game is in saved state rather than in the call."""

    def park_fomod(self, domain="eldenring", app_id=1245620, install_dir="ELDEN RING"):
        token = f"t-{domain}"
        main.PENDING_FOMODS[token] = {"at": 0, "scratch": "/nonexistent", "ctx": {},
                                      "game_domain": domain, "mod_id": 1, "file_id": 2,
                                      "mod_name": "X", "install_dir": install_dir,
                                      "app_id": app_id}
        self.addCleanup(main.PENDING_FOMODS.pop, token, None)
        return token

    def test_finishing_a_fomod_is_checked_when_it_finishes(self):
        # The token was made while the override was on; it is off now.
        run(self.plugin.forge_set_anticheat_override(1245620, True, ""))
        token = self.park_fomod()
        run(self.plugin.forge_set_anticheat_override(1245620, False, ""))
        for r in (run(self.plugin.install_fomod(token, ["a"])),
                  run(self.plugin.install_fomod_auto(token, {"type": "choices"}))):
            self.assertTrue(r.get("anticheat_locked"), r)
        self.assertIn(token, main.PENDING_FOMODS)

    def test_a_fomod_token_with_only_a_domain_is_resolved(self):
        token = self.park_fomod(app_id=0, install_dir="")
        self.assertTrue(run(self.plugin.install_fomod(token, ["a"])).get("anticheat_locked"))

    def test_an_expired_fomod_token_is_left_to_the_call(self):
        r = run(self.plugin.install_fomod_auto("gone", {}))
        self.assertFalse(r.get("anticheat_locked"))
        self.assertFalse(r["ok"])

    def test_script_extender_dlls_come_back_only_when_unlocked(self):
        on = run(self.plugin.set_script_extender_plugins("ELDEN RING", "/x", ["a.dll"], True))
        self.assertTrue(on.get("anticheat_locked"))
        off = run(self.plugin.set_script_extender_plugins("ELDEN RING", "/x", ["a.dll"], False))
        self.assertFalse(off.get("anticheat_locked"))

    def test_crash_hunt_is_gated_from_its_saved_state(self):
        r = run(self.plugin.crash_bisect_start(1245620, "ELDEN RING", "x", "starred", "eldenring",
                                               "", "", []))
        self.assertTrue(r.get("anticheat_locked"))
        with mock.patch.object(main, "_bisect_load",
                               return_value={"app_id": 1245620, "game_domain": "eldenring",
                                             "install_dir": "ELDEN RING"}):
            self.assertTrue(run(self.plugin.crash_bisect_apply()).get("anticheat_locked"))
            self.assertTrue(run(self.plugin.crash_bisect_finish(True)).get("anticheat_locked"))
        with mock.patch.object(main, "_bisect_load", return_value={}):
            r = run(self.plugin.crash_bisect_apply())
        self.assertFalse(r.get("anticheat_locked"))
        self.assertIn("No hunt", r["error"])

    def test_other_enable_paths_are_gated(self):
        calls = [
            self.plugin.set_mod_option("eldenring", "SomeMod", "v2"),
            self.plugin.set_load_order(1245620, "ELDEN RING", "x", "starred", "eldenring", []),
            self.plugin.fix_load_order(1245620, "ELDEN RING", "x", "starred", "eldenring"),
            self.plugin.apply_known_verdicts("eldenring", "ELDEN RING", "mods"),
            self.plugin.bg3_disable_broken_deps("eldenring", "ELDEN RING"),
            self.plugin.set_bg3_module_cap("eldenring", "ELDEN RING", 0),
            self.plugin.resolve_file_conflicts("eldenring", "ELDEN RING", "mods"),
            self.plugin.set_experimental_framework(1245620, "redetect"),
        ]
        for c in calls:
            self.assertTrue(run(c).get("anticheat_locked"), c)
        r = run(self.plugin.set_experimental_framework(1245620, "none"))
        self.assertFalse(r.get("anticheat_locked"))

    def test_gotr_on_is_gated_off_is_not(self):
        # No Saints Row 2 registered anywhere: the game cannot be told, so on
        # is refused and off still goes through.
        with mock.patch.object(main, "_experimental_game_for", return_value=None):
            on = run(self.plugin.set_gotr_all(True))
            self.assertTrue(on.get("anticheat_locked"))
            self.assertEqual(on.get("reason"), "game_unknown")
            self.assertTrue(run(self.plugin.set_gotr_option("X", True)).get("anticheat_locked"))
            self.assertFalse(run(self.plugin.set_gotr_all(False)).get("anticheat_locked"))


class FailClosedTests(BackendLockTests):
    """F2: a game the gate cannot resolve is refused, never allowed."""

    def test_an_unregistered_domain_is_refused(self):
        r = run(self.plugin.set_framework_enabled("neverregistered", True))
        self.assertFalse(r["ok"])
        self.assertTrue(r["anticheat_locked"])
        self.assertEqual(r["reason"], "game_unknown")
        self.assertIn("couldn't tell which game", r["error"])
        r = run(self.plugin.install_mod(*install_args("neverregistered", 0, "")))
        self.assertEqual(r.get("reason"), "game_unknown")

    def test_switching_off_an_unknown_game_still_works(self):
        r = run(self.plugin.set_framework_enabled("neverregistered", False))
        self.assertNotEqual(r.get("reason"), "game_unknown")

    def test_an_error_in_the_lookup_refuses(self):
        with mock.patch.object(main, "_forge_state", side_effect=OSError("disk")):
            r = run(self.plugin.install_mod(*install_args("stardewvalley", 413150, "Stardew Valley")))
        self.assertEqual(r.get("reason"), "game_unknown")

    def test_a_broken_folder_walk_still_locks_a_listed_game(self):
        with mock.patch.object(main, "_forge_folder_hit", side_effect=OSError("walk")):
            self.assertTrue(run(self.plugin.install_mod(*install_args())).get("anticheat_locked"))
            r = run(self.plugin.install_mod(*install_args("stardewvalley", 413150, "Stardew Valley")))
        self.assertFalse(r.get("anticheat_locked"))

    def test_the_backend_resolves_from_its_own_records(self):
        st = main._forge_state()
        st["games"] = {}
        main._forge_write(main.FORGE_STATE, st)
        # Not registered by the frontend; a restore point recorded the id.
        s = main._load_settings()
        s["domain_app_ids"] = {"eldenring": 1245620}
        main._save_settings(s)
        self.assertTrue(run(self.plugin.set_framework_enabled("eldenring", True)).get("anticheat_locked"))

    def test_an_install_folder_alone_resolves_through_steam_manifests(self):
        st = main._forge_state()
        st["games"] = {}
        main._forge_write(main.FORGE_STATE, st)
        lib = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, lib, True)
        with open(os.path.join(lib, "appmanifest_1245620.acf"), "w") as f:
            f.write('"AppState"\n{\n\t"appid"\t"1245620"\n\t"installdir"\t"ELDEN RING"\n}\n')
        with mock.patch.object(main, "_steam_libraries", return_value=[lib]):
            r = run(self.plugin.set_script_extender_plugins("ELDEN RING", "/x", ["a.dll"], True))
        self.assertTrue(r.get("anticheat_locked"))
        self.assertNotEqual(r.get("reason"), "game_unknown")


# Every backend callable that is NOT gated, and why it may stay open: it only
# reads, switches off, removes, records bookkeeping, or acts outside the game.
# A new callable fails StructuralGateTests until it is gated or listed here.
ALLOWED_UNGATED = {
    "read-only": {
        "build_report", "check_docs_file", "check_experimental_coverage", "check_framework_update",
        "check_game_file", "check_plugin_masters", "check_updates", "crash_bisect_status",
        "crash_since", "experimental_folder_options", "export_mod_setup", "find_collection",
        "find_experimental_game", "forge_game_status", "forge_guard_plan", "forge_modded_state",
        "forge_optiscaler_installed", "forge_optiscaler_status",
        # Load order: reads the game's files; forge_lo_get may refresh the
        # cached LOOT masterlist in Forge's own runtime folder.
        "forge_lo_status", "forge_lo_get", "forge_profile_plan",
        "forge_save_backup_list", "forge_save_backup_status", "forge_update_dots", "gb_get_game", "gb_get_mod", "gb_list_mods", "gb_search_games",
        "gb_update_target", "get_auth_status", "get_blamed_folders", "get_collection",
        "get_collection_attention", "get_collection_extras", "get_collection_manifest",
        "get_collection_support", "get_collection_verdicts", "get_collections", "get_debug_info",
        "get_disk_usage", "get_display_fix", "get_download_control", "get_endorsement",
        "get_experimental_state", "get_file_conflicts", "get_framework_setup", "get_frosty_state",
        "get_game_binary_version", "get_game_categories", "get_game_status", "get_gotr_options",
        "get_health_check", "get_install_block", "get_install_integrity", "get_installed_count",
        "get_installed_mods", "get_known_bad_state", "get_known_mod_verdict",
        "get_launch_options_state", "get_library_scan", "get_load_order", "get_load_order_games",
        "get_load_order_state", "get_me3_coop_password", "get_me3_launch_command", "get_me3_state",
        "get_me3_status", "get_merge_support", "get_mod_details", "get_mod_files",
        "get_mod_load_status", "get_mod_options", "get_mod_overlaps", "get_mod_program",
        "get_mod_requirements", "get_mod_setups", "get_mod_support", "get_mods", "get_mods_by_ids",
        "get_nxm_queue", "get_plugin_update", "get_prefix_runtime_state", "get_prefix_tools_state",
        "get_reinstall_target", "get_repair_queue", "get_restore_plan", "get_save_status",
        "get_script_extender_state", "get_show_adult", "get_smapi_load_status", "get_space_report",
        "get_trending_mods", "get_unsupported_mods", "get_update_hold", "get_user_prefs",
        "get_user_tool_status", "get_vr_files", "get_vr_releases", "get_vr_setup",
        "get_waiting_updates", "in_game_since", "list_restore_points", "list_setup_backups",
        "match_file_to_game", "ping", "read_setup_backup", "scan_steam_library",
    },
    "switch off": {
        "apply_known_bad", "clear_framework_launch_options", "disable_blocked_plugins",
        "disable_failing_mods", "disable_plugins", "enforce_skips", "park_failing_mods",
        "remove_ghost_plugins",
    },
    "remove / uninstall": {
        "delete_mod_setup", "remove_experimental_framework", "remove_experimental_game",
        "remove_merge_support", "remove_reshade", "remove_vr_repo", "reset_frosty",
        "reset_game_modding", "uninstall_all_mods", "uninstall_collection", "uninstall_frosty_mod",
        "uninstall_mod", "clear_space_item", "forget_vr_setup", "forge_optiscaler_remove",
    },
    # Plugin state, records and settings: nothing reaches a game's files.
    "bookkeeping": {
        "cancel_collection_install", "cancel_download", "cancel_library_check",
        "cancel_vr_recording", "crash_bisect_record", "create_restore_point", "dismiss_update",
        "endorse_collection", "finish_vr_recording", "forge_guard_dismiss", "forge_guard_exit",
        "forge_guard_launch", "forge_guard_restored", "forge_guard_undone", "forge_note_modded",
        "forge_register_games", "forge_set_anticheat_override", "forge_set_modded_collection",
        # Ludusavi copies the saves into its own backup folder.
        "forge_save_backup", "forge_save_backup_settings",
        # OptiScaler's run watch: times in forge.json, no files.
        "forge_optiscaler_dismiss", "forge_optiscaler_exit", "forge_optiscaler_launch",
        # Pins and profiles live in forge.json; switching applies them
        # through gated calls.
        "forge_lo_pin", "forge_profile_save", "forge_profile_delete",
        "gb_link_game", "gb_unlink_game", "mark_launch_options_set", "mark_vr_releases_seen",
        "note_update_hold", "record_collection_installed", "refresh_content_gate",
        "register_collection", "release_update_hold", "save_experimental_game", "save_mod_setup",
        "save_problem_report", "set_api_key", "set_collection_attention", "set_downloads_paused",
        "set_endorsement", "set_experimental_domain", "set_experimental_enabled",
        "set_experimental_focus", "set_experimental_mods_folder", "set_me3_coop_password",
        "set_show_adult", "set_update_hold_enabled", "set_user_prefs", "skip_prefix_tools",
        "start_library_check", "start_vr_recording", "add_vr_repo", "open_vr_hub",
        "register_nxm_handler", "unregister_nxm_handler", "prepare_plugin_update",
    },
    # Downloads into Forge's own cache: nothing reaches the game until a
    # gated install.
    "download only": {"prefetch_mod_file", "prepare_mod_file"},
    # Unmaps a mod loader's console window under gamescope (a no-op on
    # Windows); no files, no mods.
    "window only": {"hide_loader_console"},
    # Mod tools fetched into Forge's own folder; using one for a game goes
    # through set_framework_launch_options / install_framework, both gated.
    "tool into Forge's folder": {"install_me3", "install_frosty_toolkit"},
    # Game settings, saves and the Proton prefix, never mod content.
    "game settings and prefix": {
        "apply_display_fix", "copy_saves_to_modded", "enable_papyrus_logging",
        "fix_prefix_runtime", "restore_point_saves", "seed_game_ini",
        # Ludusavi puts a save backup back, after a confirmation and a fresh
        # backup of the current saves.
        "forge_save_restore",
    },
}


class StructuralGateTests(unittest.TestCase):
    """Every backend callable is either behind the anti-cheat gate or on the
    allow-list with a reason. A new install or enable path cannot slip in."""

    @staticmethod
    def callables():
        import inspect
        return {n for n in dir(main.Plugin)
                if not n.startswith("_") and inspect.iscoroutinefunction(getattr(main.Plugin, n))}

    def test_every_callable_is_gated_or_allowed(self):
        allowed = set().union(*ALLOWED_UNGATED.values())
        unaccounted = sorted(n for n in self.callables()
                             if not getattr(getattr(main.Plugin, n), "__forge_gated__", False)
                             and n not in allowed)
        self.assertEqual(unaccounted, [], "gate these in _FORGE_GATED, or allow-list them with a reason")

    def test_every_gated_name_is_really_wrapped(self):
        for name in main._FORGE_GATED:
            self.assertTrue(getattr(getattr(main.Plugin, name), "__forge_gated__", False), name)

    def test_the_allow_list_has_no_stale_or_gated_names(self):
        allowed = set().union(*ALLOWED_UNGATED.values())
        self.assertEqual(sorted(allowed - self.callables()), [])
        self.assertEqual(sorted(allowed & set(main._FORGE_GATED)), [])
        sizes = sum(len(v) for v in ALLOWED_UNGATED.values())
        self.assertEqual(sizes, len(allowed), "a name is listed under two reasons")


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


class ModdedRuleTests(unittest.TestCase):
    """Which games belong in the Steam collection "Modded"."""

    def test_a_game_with_a_mod_on_is_in_and_with_none_on_is_out(self):
        m = fg.note_modded({}, [[413150, "stardewvalley", 2], [892970, "valheim", 0]], 100)
        self.assertEqual(fg.modded_apps(m), [413150])
        m = fg.note_modded(m, [[413150, "stardewvalley", 0]], 200)
        self.assertEqual(fg.modded_apps(m), [])

    def test_a_partial_note_leaves_the_other_games_alone(self):
        m = fg.note_modded({}, [[1, "a", 1], [2, "b", 3]], 100)
        m = fg.note_modded(m, [[2, "b", 0]], 200)
        self.assertEqual(fg.modded_apps(m), [1])

    def test_a_complete_note_drops_games_it_does_not_name(self):
        m = fg.note_modded({}, [[1, "a", 1], [2, "b", 1]], 100)
        m = fg.note_modded(m, [[1, "a", 1]], 200, complete=True)
        self.assertEqual(fg.modded_apps(m), [1])

    def test_an_unreadable_count_keeps_what_was_known(self):
        m = fg.note_modded({}, [[1, "a", 1]], 100)
        m = fg.note_modded(m, [[1, "a", fg.MODDED_UNKNOWN], [2, "b", fg.MODDED_UNKNOWN]], 200, complete=True)
        self.assertEqual(fg.modded_apps(m), [1])
        self.assertEqual(m["1"]["at"], 100)

    def test_junk_entries_are_ignored(self):
        m = fg.note_modded({}, [None, [0, "a", 1], ["x", "a", 1], [5, "a"], [-3, "a", 1], [7, "g", "2"]], 1)
        self.assertEqual(fg.modded_apps(m), [7])

    def test_collection_record_keeps_only_what_forge_needs(self):
        self.assertEqual(fg.clean_collection_record(None), {})
        self.assertEqual(fg.clean_collection_record({"name": "Modded"}), {})
        self.assertEqual(fg.clean_collection_record({"id": "x" * 200}), {})
        rec = fg.clean_collection_record({"id": "uc-abc", "name": "Modded (Forge)", "added": [3, "2", 3, -1, "z"],
                                          "clash": "Modded", "other": 1})
        self.assertEqual(rec, {"id": "uc-abc", "name": "Modded (Forge)", "added": [2, 3], "clash": "Modded"})


class ModdedBackendTests(unittest.TestCase):
    def setUp(self):
        reset_forge()
        main._save_settings({"api_key": "test-key",
                             "installed": {"stardewvalley": {"SMAPI": {"mod_id": 1}}, "valheim": {}}})
        self.plugin = main.Plugin()
        run(self.plugin.forge_register_games([["eldenring", 1245620, "ELDEN RING"],
                                              ["stardewvalley", 413150, "Stardew Valley"]]))
        self.events = []

        async def emit(event, *args):
            self.events.append((event, *args))

        self.emit = mock.patch.object(main.decky, "emit", emit)
        self.emit.start()

    def tearDown(self):
        self.emit.stop()
        reset_forge()

    def test_state_survives_and_needs_no_network(self):
        with mock.patch.object(main, "_resolve_game_id", side_effect=AssertionError("network")):
            r = run(self.plugin.forge_note_modded([[413150, "stardewvalley", 2]], False))
            self.assertEqual(r["modded"], [413150])
            st = run(self.plugin.forge_modded_state())
        self.assertEqual(st["modded"], [413150])
        self.assertEqual(st["domains"], ["stardewvalley"])  # valheim has no records
        self.assertEqual(st["collection"], {})
        self.assertEqual(main._forge_read(main.FORGE_STATE)["modded"]["413150"]["domain"], "stardewvalley")

    def test_the_load_scan_replaces_the_whole_set(self):
        run(self.plugin.forge_note_modded([[1, "a", 1], [413150, "stardewvalley", 1]], False))
        r = run(self.plugin.forge_note_modded([[413150, "stardewvalley", 1]], True))
        self.assertEqual(r["modded"], [413150])

    def test_collection_record_round_trip_and_forget(self):
        run(self.plugin.forge_set_modded_collection({"id": "uc-1", "name": "Modded", "added": [413150]}))
        self.assertEqual(run(self.plugin.forge_modded_state())["collection"],
                         {"id": "uc-1", "name": "Modded", "added": [413150]})
        run(self.plugin.forge_set_modded_collection({}))
        self.assertEqual(run(self.plugin.forge_modded_state())["collection"], {})

    def test_switching_mods_tells_the_frontend_which_game(self):
        run(self.plugin.set_mod_enabled("Stardew Valley", "Mods", "Nope", False, "folder",
                                        "stardewvalley", 413150))
        self.assertIn(("forge_mods_changed", "stardewvalley", 413150), self.events)

    def test_switching_all_off_for_a_locked_game_is_announced(self):
        # The anti-cheat lock's "switch mods off" is set_all_mods_enabled(False).
        run(self.plugin.set_all_mods_enabled("ELDEN RING", "mods", False, "folder", "eldenring", 1245620))
        self.assertIn(("forge_mods_changed", "eldenring", 1245620), self.events)

    def test_a_refused_call_changed_nothing_and_says_nothing(self):
        r = run(self.plugin.install_mod(*install_args()))
        self.assertTrue(r["anticheat_locked"])
        self.assertEqual([e for e in self.events if e[0] == "forge_mods_changed"], [])

    def test_a_call_without_a_domain_asks_for_a_full_recount(self):
        run(self.plugin.install_fomod("no-such-token", [], False))
        self.assertIn(("forge_mods_changed", "", 0), self.events)

    def test_every_announcing_method_exists_and_keeps_its_signature(self):
        import inspect
        for name in main._FORGE_MOD_CHANGES:
            self.assertTrue(hasattr(main.Plugin, name), name)
        self.assertIn("set_all_mods_enabled", main._FORGE_MOD_CHANGES)
        self.assertIn("uninstall_mod", main._FORGE_MOD_CHANGES)
        self.assertNotIn("run_mod_program", main._FORGE_MOD_CHANGES)
        params = list(inspect.signature(main.Plugin.uninstall_mod).parameters)
        self.assertEqual(params[:3], ["self", "game_domain", "install_dir"])


if __name__ == "__main__":
    unittest.main()


class WindowsSkipsProtonOnlyStepsTests(unittest.TestCase):
    """Upstream's Proton/gamescope steps (v1.21.37) stay off on Windows:
    Windows loads a proxy dll from the game folder by itself, Windows Steam
    cannot run an env-var prefix in launch options, and a loader console
    hides nothing on a Windows desktop."""

    def test_the_loader_console_watch_is_a_no_op_on_windows(self):
        with mock.patch.object(main.sys, "platform", "win32"), \
                mock.patch.object(main, "_unmap_windows_by_prefix") as unmap:
            result = asyncio.run(main.Plugin().hide_loader_console("SoWPL", 5))
        self.assertEqual(result, {"ok": True, "hidden": 0})
        unmap.assert_not_called()

    def test_no_launch_override_is_sent_on_windows(self):
        import inspect
        src = inspect.getsource(main.Plugin._install_mod_inner)
        i = src.index('proxies = extras.get("proxy_dlls")')
        self.assertIn('if proxies and sys.platform != "win32":', src[i:i + 400])
        with open(os.path.join(os.path.dirname(os.path.abspath(main.__file__)),
                               "src", "install.ts"), encoding="utf-8") as fh:
            self.assertIn("result.launch_overrides && !IS_WINDOWS", fh.read())
