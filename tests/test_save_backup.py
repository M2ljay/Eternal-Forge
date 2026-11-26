"""Forge's save backups through Ludusavi: finding it, Ludusavi's name for the
game, the time box, the skip window, restore taking a backup first, and a
failed backup never standing in the way of a mod change. Ludusavi itself is
a fake script that answers like its --api mode and logs every call."""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock

from test_backend import main, real_forge_resolver

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
import save_backup as sb  # noqa: E402


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


FAKE = textwrap.dedent('''\
    import json, os, sys, time
    here = os.path.dirname(os.path.abspath(__file__))
    conf = json.load(open(os.path.join(here, "conf.json")))
    argv = sys.argv[1:]
    with open(os.path.join(here, "calls.jsonl"), "a") as f:
        f.write(json.dumps(argv) + "\\n")
    args = [a for a in argv if a != "--try-manifest-update"]
    sub, rest = args[0], args[1:]
    plain = [a for a in rest if not a.startswith("--")]
    def out(data, rc=0):
        print(json.dumps(data))
        sys.exit(rc)
    if sub == "find":
        if "--steam-id" in rest:
            title = conf.get("steam", {}).get(rest[rest.index("--steam-id") + 1])
            titles = [title] if title else []
        elif "--normalized" in rest:
            titles = conf.get("normalized", {}).get(plain[0], [])
        else:
            titles = [plain[0]] if plain[0] in conf.get("titles", []) else []
        if not titles:
            sys.stderr.write("No games found\\n")
            out({"errors": {}, "games": {}}, 1)
        out({"games": {t: {"score": None} for t in titles}})
    if sub == "backup":
        mode, title = conf.get("backup", "ok"), plain[-1]
        if mode == "sleep":
            time.sleep(30)
        if mode == "crash":
            sys.stderr.write("thread main panicked\\n")
            sys.exit(101)
        if mode == "unknown":
            out({"errors": {"unknownGames": [title]}, "games": {}}, 1)
        failed = mode == "partial"
        out({"errors": {"someGamesFailed": True} if failed else {},
             "overall": {"totalGames": 1, "totalBytes": 10, "processedGames": 1, "processedBytes": 10},
             "games": {title: {"decision": "Processed", "change": "New", "dump": {}, "registry": {},
                               "files": {"C:/Saves/one.sav": {"bytes": 10, "change": "New", "duplicatedBy": [],
                                                              "failed": failed, "ignored": False}}}}},
            1 if failed else 0)
    if sub == "backups":
        title = plain[-1]
        if not conf.get("backups"):
            out({"games": {}})
        out({"games": {title: {"backupPath": "D:/ludusavi-backup/" + title, "backups": conf["backups"]}}})
    if sub == "restore":
        title = plain[-1]
        if conf.get("restore") == "fail":
            out({"errors": {"someGamesFailed": True}, "games": {}}, 1)
        out({"games": {title: {"decision": "Processed", "change": "Different", "dump": {}, "registry": {},
                               "files": {"C:/Saves/one.sav": {"bytes": 10, "change": "Different",
                                                              "duplicatedBy": [], "failed": False,
                                                              "ignored": False}}}}})
    sys.exit(2)
''')


class FakeLudusavi:
    def __init__(self, **conf):
        self.dir = tempfile.mkdtemp(prefix="fake-ludusavi-")
        self.exe = os.path.join(self.dir, "ludusavi")
        with open(os.path.join(self.dir, "fake.py"), "w") as f:
            f.write(FAKE)
        with open(self.exe, "w") as f:
            f.write(f"#!/bin/sh\nexec '{sys.executable}' -I '{os.path.join(self.dir, 'fake.py')}' \"$@\"\n")
        os.chmod(self.exe, 0o755)
        self.configure(**conf)

    def configure(self, **conf):
        base = {"steam": {"413150": "Stardew Valley", "1245620": "ELDEN RING"},
                "titles": ["Stardew Valley", "ELDEN RING", "Hades"], "backup": "ok"}
        base.update(conf)
        with open(os.path.join(self.dir, "conf.json"), "w") as f:
            json.dump(base, f)

    def calls(self):
        try:
            with open(os.path.join(self.dir, "calls.jsonl")) as f:
                return [json.loads(line) for line in f if line.strip()]
        except OSError:
            return []

    def subcommands(self):
        return [[a for a in c if a != "--try-manifest-update"][0] for c in self.calls()]

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


# ---- The module on its own ----------------------------------------------------------

class DetectionTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ludusavi-detect-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def touch(self, *parts):
        path = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").close()
        return path

    def find(self, env, which=lambda name, path=None: None):
        return sb.find_ludusavi(env, which=which, platform="win32")

    def test_path_comes_first(self):
        self.touch("Local", "Microsoft", "WinGet", "Links", "ludusavi.exe")
        hit = sb.find_ludusavi({"PATH": "x", "LOCALAPPDATA": os.path.join(self.root, "Local")},
                               which=lambda name, path=None: "C:/Tools/ludusavi.exe" if name == "ludusavi" else None,
                               platform="win32")
        self.assertEqual(hit, "C:/Tools/ludusavi.exe")

    def test_winget_portable_package_folder(self):
        exe = self.touch("Local", "Microsoft", "WinGet", "Packages",
                         "mtkennerly.ludusavi_Microsoft.Winget.Source_8wekyb3d8bbwe", "ludusavi.exe")
        self.assertEqual(self.find({"LOCALAPPDATA": os.path.join(self.root, "Local")}), exe)

    def test_winget_links_folder(self):
        exe = self.touch("Local", "Microsoft", "WinGet", "Links", "ludusavi.exe")
        self.assertEqual(self.find({"LOCALAPPDATA": os.path.join(self.root, "Local")}), exe)

    def test_machine_wide_winget(self):
        exe = self.touch("PF", "WinGet", "Packages", "mtkennerly.ludusavi_Microsoft.Winget.Source_x", "ludusavi.exe")
        self.assertEqual(self.find({"ProgramFiles": os.path.join(self.root, "PF")}), exe)

    def test_scoop(self):
        exe = self.touch("User", "scoop", "apps", "ludusavi", "current", "ludusavi.exe")
        self.assertEqual(self.find({"USERPROFILE": os.path.join(self.root, "User")}), exe)
        other = self.touch("CustomScoop", "shims", "ludusavi.exe")
        self.assertEqual(self.find({"SCOOP": os.path.join(self.root, "CustomScoop")}), other)

    def test_another_winget_package_is_not_ludusavi(self):
        self.touch("Local", "Microsoft", "WinGet", "Packages", "someone.else_x", "ludusavi.exe")
        self.assertEqual(self.find({"LOCALAPPDATA": os.path.join(self.root, "Local")}), "")

    def test_absent_is_empty(self):
        self.assertEqual(self.find({"LOCALAPPDATA": os.path.join(self.root, "nothing")}), "")
        self.assertEqual(self.find({}), "")


class TitleTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeLudusavi(normalized={"Hades II Deluxe": ["Hades II"], "Doom": ["DOOM", "DOOM (1993)"]})

    def tearDown(self):
        self.fake.cleanup()

    def test_steam_id_first(self):
        self.assertEqual(sb.find_title(self.fake.exe, 413150, "Stardew Valley"), "Stardew Valley")
        self.assertEqual(len(self.fake.calls()), 1)
        self.assertIn("--steam-id", self.fake.calls()[0])
        self.assertEqual(self.fake.calls()[0][:2], ["--try-manifest-update", "find"])

    def test_name_when_the_id_is_unknown(self):
        self.assertEqual(sb.find_title(self.fake.exe, 1145360, "Hades"), "Hades")
        self.assertEqual(sb.find_title(self.fake.exe, 1145350, "Hades II Deluxe"), "Hades II")

    def test_a_shortcut_id_is_never_sent_as_a_steam_id(self):
        self.assertEqual(sb.find_title(self.fake.exe, 3000000000, "Hades"), "Hades")
        self.assertFalse(any("--steam-id" in c for c in self.fake.calls()))

    def test_ambiguous_or_unknown_is_empty(self):
        self.assertEqual(sb.find_title(self.fake.exe, 0, "Doom"), "")
        self.assertEqual(sb.find_title(self.fake.exe, 0, "No Such Game"), "")
        self.assertEqual(sb.find_title(self.fake.exe, 3000000000, ""), "")

    def test_remembered_titles_expire(self):
        now = 10_000_000
        self.assertEqual(sb.cached_title({"title": "Hades", "title_at": now - 3600}, now), "Hades")
        self.assertIsNone(sb.cached_title({"title": "Hades", "title_at": now - sb.TITLE_TTL - 1}, now))
        self.assertEqual(sb.cached_title({"title": "", "title_at": now - 3600}, now), "")
        self.assertIsNone(sb.cached_title({"title": "", "title_at": now - sb.MISS_TTL - 1}, now))
        self.assertIsNone(sb.cached_title({}, now))


class OutputTests(unittest.TestCase):
    def test_ok_failed_unknown_and_cloud(self):
        ok = sb._outcome({"rc": 0, "out": json.dumps({"games": {"G": {"decision": "Processed", "files": {
            "a": {"bytes": 5, "failed": False, "ignored": False}}, "registry": {}}}})}, "G", "backup", 60)
        self.assertEqual((ok["ok"], ok["files"], ok["bytes"]), (True, 1, 5))
        failed = sb._outcome({"rc": 1, "out": json.dumps({"errors": {"someGamesFailed": True}, "games": {
            "G": {"decision": "Processed", "files": {"a": {"failed": True}}}}})}, "G", "backup", 60)
        self.assertFalse(failed["ok"])
        self.assertIn("1 file", failed["error"])
        unknown = sb._outcome({"rc": 1, "out": json.dumps({"errors": {"unknownGames": ["G"]}, "games": {}})},
                              "G", "backup", 60)
        self.assertTrue(unknown["unknown"])
        cloud = sb._outcome({"rc": 0, "out": json.dumps({"errors": {"cloudSyncFailed": {}}, "games": {
            "G": {"decision": "Processed", "files": {}, "registry": {}}}})}, "G", "backup", 60)
        self.assertTrue(cloud["ok"])
        self.assertTrue(cloud["empty"])
        self.assertIn("cloud", cloud["note"])

    def test_blank_or_garbled_stdout(self):
        self.assertFalse(sb._outcome({"rc": 1, "out": "", "err": "boom\nmore"}, "G", "backup", 60)["ok"])
        self.assertIn("boom", sb._outcome({"rc": 1, "out": "", "err": "boom"}, "G", "backup", 60)["error"])
        self.assertEqual(sb.parse_api('warning: x\n{"games": {}}'), {"games": {}})
        self.assertIsNone(sb.parse_api("not json"))

    def test_times_with_nanoseconds(self):
        self.assertEqual(sb.parse_when("2024-06-26T10:06:14.120957700Z"), 1719396374)
        self.assertEqual(sb.parse_when("2024-06-26T12:06:14+02:00"), 1719396374)
        self.assertEqual(sb.parse_when("yesterday"), 0)

    def test_skip_window(self):
        self.assertTrue(sb.should_skip(1000, 1000 + 29 * 60, 30))
        self.assertFalse(sb.should_skip(1000, 1000 + 31 * 60, 30))
        self.assertFalse(sb.should_skip(0, 5000, 30))
        self.assertFalse(sb.should_skip(1000, 1010, 0))
        self.assertEqual(sb.clamp_minutes("x"), sb.DEFAULT_SKIP_MINUTES)
        self.assertEqual(sb.clamp_minutes(-5), 0)
        self.assertEqual(sb.clamp_minutes(10 ** 6), sb.MAX_SKIP_MINUTES)

    def test_no_console_window_on_windows(self):
        seen = {}

        def fake_run(argv, **kw):
            seen.update(kw)
            raise OSError("not really")
        with mock.patch.object(sb, "NO_WINDOW", {"creationflags": 0x08000000}), \
                mock.patch.object(sb.subprocess, "run", fake_run):
            r = sb.run_ludusavi(["ludusavi", "backups"], 5)
        self.assertEqual(seen.get("creationflags"), 0x08000000)
        self.assertEqual(seen.get("timeout"), 5)
        self.assertEqual(r["rc"], -1)

    def test_listing_is_newest_first(self):
        fake = FakeLudusavi(backups=[
            {"name": ".", "when": "2026-11-01T10:00:00.5Z", "locked": False, "comment": None, "os": "windows"},
            {"name": "dif-20261120T100000Z", "when": "2026-11-20T10:00:00Z", "locked": True,
             "comment": "before DLC", "os": "windows"}])
        try:
            r = sb.list_backups(fake.exe, "Hades")
        finally:
            fake.cleanup()
        self.assertTrue(r["ok"])
        self.assertEqual([b["id"] for b in r["backups"]], ["dif-20261120T100000Z", "."])
        self.assertEqual(r["backups"][0]["comment"], "before DLC")
        self.assertTrue(r["path"].endswith("Hades"))


# ---- The backend --------------------------------------------------------------------

def install_args(domain="stardewvalley", app_id=413150, install_dir="Stardew Valley"):
    return (domain, 1, 2, "x.zip", "X", "1.0", install_dir, "Mods", "", "", "folder", app_id)


class _Backend(unittest.TestCase):
    def setUp(self):
        for p in (main.FORGE_STATE, main.FORGE_UPDATE_CACHE):
            try:
                os.remove(p)
            except OSError:
                pass
        main._FORGE_SCAN_CACHE.clear()
        self.fake = FakeLudusavi()
        self.patches = [mock.patch.object(main, "_LUDUSAVI_FIND", lambda: self.fake.exe),
                        mock.patch.dict(main._LUDUSAVI, {"path": "", "at": 0.0})]
        self.events = []

        async def emit(event, *args):
            self.events.append((event, args))
        self.patches.append(mock.patch.object(main.decky, "emit", emit))
        for p in self.patches:
            p.start()
        main._save_settings({"api_key": "test-key", "installed": {}})
        self.plugin = main.Plugin()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.fake.cleanup()

    def backup_events(self):
        return [a for e, a in self.events if e == "forge_save_backup"]


class BackendTests(_Backend):
    def test_install_backs_up_first_then_skips_within_the_window(self):
        clock = [1_000_000.0]
        with mock.patch.object(main.time, "time", lambda: clock[0]):
            run(self.plugin.install_mod(*install_args()))
            self.assertEqual(self.fake.subcommands(), ["find", "backup"])
            self.assertEqual(self.fake.calls()[1][-1], "Stardew Valley")
            self.assertIn("--force", self.fake.calls()[1])
            self.assertIn("--api", self.fake.calls()[1])
            clock[0] += 10 * 60
            run(self.plugin.install_mod(*install_args()))
            run(self.plugin.set_mod_enabled("Stardew Valley", "Mods", "SomeMod", True, "folder",
                                            "stardewvalley", 413150))
            self.assertEqual(self.fake.subcommands(), ["find", "backup"])
            clock[0] += 25 * 60
            run(self.plugin.install_mod(*install_args()))
            # The title is remembered: no second lookup.
            self.assertEqual(self.fake.subcommands(), ["find", "backup", "backup"])
            st = run(self.plugin.forge_save_backup_status(413150))
        self.assertTrue(st["found"])
        self.assertEqual(st["game"]["last_backup_at"], int(clock[0]))
        self.assertEqual(st["game"]["title"], "Stardew Valley")
        self.assertEqual(len(self.backup_events()), 2)
        self.assertTrue(self.backup_events()[0][1]["ok"])

    def test_switching_off_never_backs_up(self):
        run(self.plugin.set_mod_enabled("Stardew Valley", "Mods", "SomeMod", False, "folder",
                                        "stardewvalley", 413150))
        run(self.plugin.uninstall_mod("stardewvalley", "Stardew Valley", "Mods", "SomeMod"))
        self.assertEqual(self.fake.calls(), [])

    def test_the_skip_window_is_configurable(self):
        run(self.plugin.forge_save_backup_settings(True, 0))
        run(self.plugin.install_mod(*install_args()))
        run(self.plugin.install_mod(*install_args()))
        self.assertEqual(self.fake.subcommands(), ["find", "backup", "backup"])
        self.assertEqual(run(self.plugin.forge_save_backup_status(0))["skip_minutes"], 0)

    def test_switched_off_in_settings(self):
        r = run(self.plugin.forge_save_backup_settings(False))
        self.assertFalse(r["enabled"])
        run(self.plugin.install_mod(*install_args()))
        self.assertEqual(self.fake.calls(), [])
        self.assertEqual(self.backup_events(), [])

    def test_on_by_default(self):
        st = run(self.plugin.forge_save_backup_status(0))
        self.assertTrue(st["enabled"])
        self.assertEqual(st["skip_minutes"], 30)

    def test_time_box_stops_ludusavi_and_the_install_goes_ahead(self):
        self.fake.configure(backup="sleep")
        calls = []

        async def install(self_, app_id, game_domain=""):
            calls.append(app_id)
            return {"ok": True}
        with mock.patch.object(sb, "BACKUP_TIMEOUT", 2), \
                mock.patch.dict(main._FORGE_GATED, {"fake_install": None}, clear=True), \
                mock.patch.object(main.Plugin, "fake_install", install, create=True):
            main._wrap_save_backups()
            started = time.monotonic()
            r = run(main.Plugin().fake_install(413150))
            took = time.monotonic() - started
        self.assertEqual(r, {"ok": True})
        self.assertEqual(calls, [413150])
        self.assertLess(took, 15)
        ev = self.backup_events()
        self.assertEqual(len(ev), 1)
        self.assertFalse(ev[0][1]["ok"])
        self.assertIn("longer than", ev[0][1]["error"])
        st = run(self.plugin.forge_save_backup_status(413150))["game"]
        self.assertFalse(st["last_ok"])
        self.assertEqual(st["last_backup_at"], 0)

    def test_a_failing_ludusavi_never_blocks_the_install(self):
        for mode in ("crash", "partial", "unknown"):
            self.fake.configure(backup=mode)
            run(self.plugin.forge_save_backup_settings(True, 0))
            calls = []

            async def install(self_, app_id, game_domain=""):
                calls.append(app_id)
                return {"ok": True, "installed": 1}
            with mock.patch.dict(main._FORGE_GATED, {"fake_install": None}, clear=True), \
                    mock.patch.object(main.Plugin, "fake_install", install, create=True):
                main._wrap_save_backups()
                r = run(main.Plugin().fake_install(413150))
            self.assertEqual(r, {"ok": True, "installed": 1}, mode)
            self.assertEqual(calls, [413150], mode)
            self.assertFalse(self.backup_events()[-1][1]["ok"], mode)

    def test_an_error_inside_the_backup_never_blocks_the_install(self):
        calls = []

        async def install(self_, app_id, game_domain=""):
            calls.append(app_id)
            return {"ok": True}

        def boom(*a, **k):
            raise RuntimeError("disk on fire")
        with mock.patch.dict(main._FORGE_GATED, {"fake_install": None}, clear=True), \
                mock.patch.object(main.Plugin, "fake_install", install, create=True), \
                mock.patch.object(main, "_saves_backup_blocking", boom):
            main._wrap_save_backups()
            self.assertEqual(run(main.Plugin().fake_install(413150)), {"ok": True})
        self.assertEqual(calls, [413150])

    def test_without_ludusavi_nothing_runs_and_settings_say_so(self):
        with mock.patch.object(main, "_LUDUSAVI_FIND", lambda: ""):
            main._LUDUSAVI["at"] = 0.0
            run(self.plugin.install_mod(*install_args()))
            st = run(self.plugin.forge_save_backup_status(413150, True))
            listing = run(self.plugin.forge_save_backup_list(413150, "Stardew Valley"))
        self.assertFalse(st["found"])
        self.assertEqual(st["hint"], "Install Ludusavi to back up saves before mod changes")
        self.assertIn("mtkennerly.ludusavi", st["install_command"])
        self.assertFalse(listing["ok"])
        self.assertEqual(self.backup_events(), [])
        self.assertEqual(self.fake.calls(), [])

    def test_crash_restore_backup_follows_the_window(self):
        r = run(self.plugin.forge_save_backup(413150, "Stardew Valley", "crash restore"))
        self.assertTrue(r["ok"])
        self.assertTrue(r["ran"])
        r = run(self.plugin.forge_save_backup(413150, "Stardew Valley", "undo"))
        self.assertEqual(r.get("skipped"), "recent")
        self.assertEqual(self.fake.subcommands(), ["find", "backup"])

    def test_restore_takes_a_fresh_backup_first(self):
        run(self.plugin.forge_save_backup(413150, "Stardew Valley", "crash restore"))
        r = run(self.plugin.forge_save_restore(413150, "Stardew Valley", "dif-1", True))
        self.assertTrue(r["ok"], r)
        # A backup within the window still runs again: the save being
        # replaced is the one that matters.
        self.assertEqual(self.fake.subcommands(), ["find", "backup", "backup", "restore"])
        restore = self.fake.calls()[-1]
        self.assertEqual(restore[restore.index("--backup") + 1], "dif-1")
        self.assertEqual(restore[-1], "Stardew Valley")
        self.assertIn("--force", restore)

    def test_restore_even_when_backups_are_switched_off(self):
        run(self.plugin.forge_save_backup_settings(False))
        self.assertTrue(run(self.plugin.forge_save_restore(413150, "Stardew Valley", ".", True))["ok"])
        self.assertEqual(self.fake.subcommands(), ["find", "backup", "restore"])

    def test_no_restore_when_the_fresh_backup_fails(self):
        self.fake.configure(backup="crash")
        r = run(self.plugin.forge_save_restore(413150, "Stardew Valley", ".", True))
        self.assertFalse(r["ok"])
        self.assertTrue(r["backup_failed"])
        self.assertIn("nothing was restored", r["error"])
        self.assertNotIn("restore", self.fake.subcommands())

    def test_restore_needs_the_confirmation(self):
        r = run(self.plugin.forge_save_restore(413150, "Stardew Valley", ".", False))
        self.assertFalse(r["ok"])
        self.assertEqual(self.fake.calls(), [])

    def test_a_failed_restore_says_so(self):
        self.fake.configure(restore="fail")
        r = run(self.plugin.forge_save_restore(413150, "Stardew Valley", ".", True))
        self.assertFalse(r["ok"])

    def test_listing_backups(self):
        self.fake.configure(backups=[{"name": ".", "when": "2026-11-01T10:00:00Z", "locked": False}])
        r = run(self.plugin.forge_save_backup_list(413150, "Stardew Valley"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["title"], "Stardew Valley")
        self.assertEqual([b["id"] for b in r["backups"]], ["."])

    def test_unknown_game(self):
        r = run(self.plugin.forge_save_backup(3000000001, "Some Shortcut", "manual"))
        self.assertFalse(r["ok"])
        self.assertIn("doesn't know", r["error"])
        r = run(self.plugin.forge_save_backup_list(3000000001, "Some Shortcut"))
        self.assertFalse(r["ok"])


class LockedGameTests(_Backend):
    """Backups only read the game, so the anti-cheat lock does not stop
    them; a refused install backs up nothing, and restoring saves follows
    the same confirmation as anywhere else."""

    def setUp(self):
        super().setUp()
        self.real = real_forge_resolver()
        self.real.start()
        run(self.plugin.forge_register_games([["eldenring", 1245620, "ELDEN RING"],
                                              ["stardewvalley", 413150, "Stardew Valley"]]))

    def tearDown(self):
        self.real.stop()
        super().tearDown()

    def test_a_refused_install_backs_up_nothing(self):
        r = run(self.plugin.install_mod(*install_args("eldenring", 1245620, "ELDEN RING")))
        self.assertTrue(r.get("anticheat_locked"))
        self.assertEqual(self.fake.calls(), [])

    def test_backup_and_restore_work_for_a_locked_game(self):
        self.assertTrue(run(self.plugin.forge_save_backup(1245620, "ELDEN RING", "manual"))["ok"])
        self.assertTrue(run(self.plugin.forge_save_restore(1245620, "ELDEN RING", ".", True))["ok"])
        self.assertEqual(self.fake.subcommands(), ["find", "backup", "backup", "restore"])


if __name__ == "__main__":
    unittest.main()
