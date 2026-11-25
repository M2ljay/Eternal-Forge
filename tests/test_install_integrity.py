"""anygame.67: updating safely on Windows, and saying so when an update did not
finish copying.

Decky v3.3.1 replaces a plugin by rmtree + extract (browser.py), and on
Windows either stops at the first file another process holds, leaving half of
one build and half of the other. These pin the three defences: the manifest
check at start, the preparation before handing off to Decky, and a main.py
that still starts (and can say what is wrong) when a module will not import.
"""
import ast
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from test_backend import main, REPO_ROOT, TEST_ROOT

import forge_helpers
import forge_integrity

HERE = os.path.dirname(os.path.abspath(__file__))
GUARDED = ["experimental_games", "reloaded_ii", "xenoverse2", "reshade_setup", "kingdom_hearts",
           "archive_peek", "gta_img", "memoria", "re_engine", "installers", "generic_loaders",
           "vr_setup", "vr_feed", "gamebanana", "forge_helpers"]


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _tree(root, files):
    for rel, body in files.items():
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(body)


class ManifestCheck(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(dir=TEST_ROOT)
        _tree(self.root, {"main.py": b"print(1)\n", "package.json": b'{"version": "9.9.9"}',
                          "py_modules/a.py": b"A = 1\n", "dist/index.js": b"x" * 5000})
        m = forge_integrity.build_manifest(self.root, "9.9.9")
        with open(os.path.join(self.root, forge_integrity.MANIFEST), "w") as f:
            json.dump(m, f)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def check(self):
        return forge_integrity.Checker(self.root).start(hash_in_thread=False).snapshot()

    def test_an_intact_install_is_ok(self):
        snap = self.check()
        self.assertEqual(snap["status"], "ok", snap)
        self.assertEqual(snap["version"], "9.9.9")

    def test_runtime_pycache_is_not_a_problem(self):
        _tree(self.root, {"py_modules/__pycache__/a.cpython-314.pyc": b"junk"})
        self.assertEqual(self.check()["status"], "ok")

    def test_a_missing_file_is_found_by_stat_alone(self):
        os.remove(os.path.join(self.root, "py_modules", "a.py"))
        with mock.patch.object(forge_integrity, "check_hashes", side_effect=AssertionError("hashed")):
            snap = forge_integrity.Checker(self.root).start().snapshot()
        self.assertEqual(snap["status"], "broken")
        self.assertIn("missing: py_modules/a.py", snap["problems"])

    def test_a_truncated_file_is_found_by_its_size(self):
        with open(os.path.join(self.root, "dist", "index.js"), "wb") as f:
            f.write(b"x" * 100)
        snap = self.check()
        self.assertEqual(snap["status"], "broken")
        self.assertTrue(snap["problems"][0].startswith("wrong size: dist/index.js"), snap)

    def test_same_size_other_bytes_is_found_by_hash_off_the_caller_thread(self):
        """The old build's file of the same length: only the hash tells."""
        with open(os.path.join(self.root, "main.py"), "wb") as f:
            f.write(b"print(2)\n")
        c = forge_integrity.Checker(self.root).start()
        self.assertIsNotNone(c._thread, "hashes must run on a thread, not the event loop")
        c._thread.join(10)
        snap = c.snapshot()
        self.assertEqual(snap["status"], "broken")
        self.assertEqual(snap["problems"], ["changed: main.py"])

    def test_no_manifest_is_not_reported_as_broken(self):
        os.remove(os.path.join(self.root, forge_integrity.MANIFEST))
        self.assertEqual(self.check()["status"], "no_manifest")

    def test_a_truncated_manifest_is_broken(self):
        with open(os.path.join(self.root, forge_integrity.MANIFEST), "w") as f:
            f.write('{"format": 1, "files": [')
        self.assertEqual(self.check()["status"], "broken")

    def test_manifest_paths_cannot_climb_out(self):
        m = {"format": 1, "version": "x", "files": [
            {"path": "../outside.txt", "size": 1, "sha256": "0" * 64},
            {"path": "C:/Windows/x", "size": 1, "sha256": "0" * 64}]}
        self.assertEqual(forge_integrity.check_sizes(self.root, m), [])

    def test_stop_releases_the_file_being_hashed(self):
        c = forge_integrity.Checker(self.root)
        c._cancel.set()
        m = forge_integrity.load_manifest(self.root)
        c._hash(m)  # returns quietly, verdict left as it was
        self.assertEqual(c.snapshot()["status"], "checking")

    def test_the_tool_and_the_checker_agree(self):
        """tools/make_manifest.py writes with forge_integrity itself."""
        stage = tempfile.mkdtemp(dir=TEST_ROOT)
        _tree(stage, {"package.json": b'{"version": "1.2.3"}', "main.py": b"x"})
        sys.path.insert(0, os.path.join(REPO_ROOT, "tools"))
        import make_manifest
        make_manifest.write(stage)
        snap = forge_integrity.Checker(stage).start(hash_in_thread=False).snapshot()
        self.assertEqual((snap["status"], snap["version"]), ("ok", "1.2.3"))


class StdlibOnly(unittest.TestCase):
    """The check must work when nothing else does: standard library only, and
    only what Decky's frozen Windows Python bundles."""

    def test_imports(self):
        have = set(open(os.path.join(HERE, "decky_frozen_stdlib.txt")).read().split())
        have |= set(sys.builtin_module_names)
        for mod in ("forge_integrity", "forge_helpers"):
            tree = ast.parse(open(os.path.join(REPO_ROOT, "py_modules", mod + ".py")).read())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module]
                for n in names:
                    self.assertIn(n, have, f"{mod} imports {n}, which Decky's frozen Python lacks")

    def test_main_starts_the_check_before_any_py_module(self):
        src = open(os.path.join(REPO_ROOT, "main.py")).read()
        self.assertLess(src.index("forge_integrity.begin("), src.index('_guarded_import("experimental_games")'))
        self.assertLess(src.index("import forge_integrity"), src.index("import aiohttp"))
        for name in GUARDED:
            self.assertNotRegex(src, rf"(?m)^import {name}\b", f"{name} must be imported through _guarded_import")


class StartsWhenAModuleWillNot(unittest.TestCase):
    """A half-copied install: main.py must still load under Decky's frozen
    runtime, record what failed, and report the copy broken."""

    def _copy(self):
        root = tempfile.mkdtemp(dir=TEST_ROOT)
        dst = os.path.join(root, "Nexus Mods")
        shutil.copytree(os.path.join(REPO_ROOT, "py_modules"), os.path.join(dst, "py_modules"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        for f in ("main.py", "package.json", "plugin.json"):
            shutil.copy(os.path.join(REPO_ROOT, f), dst)
        sys.path.insert(0, os.path.join(REPO_ROOT, "tools"))
        import make_manifest
        make_manifest.write(dst)
        return dst

    def _child(self, root, checks):
        from test_frozen_runtime import CHILD
        r = subprocess.run([sys.executable, "-I", "-c", CHILD, root, os.path.join(HERE, "decky_frozen_stdlib.txt"),
                            checks], capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        self.assertIn("frozen import OK", r.stdout)

    def test_intact_copy_checks_ok(self):
        root = self._copy()
        self._child(root, "mod._INTEGRITY._thread and mod._INTEGRITY._thread.join(30)\n"
                          "s = mod._INTEGRITY.snapshot()\n"
                          "assert s['status'] == 'ok' and not s['import_failures'], s\n")

    def test_each_py_module_missing_or_truncated(self):
        root = self._copy()
        for name in GUARDED:
            path = os.path.join(root, "py_modules", name + ".py")
            with open(path, "rb") as f:
                body = f.read()
            for broken in (None, body[: len(body) // 2]):
                with self.subTest(module=name, truncated=broken is not None):
                    if broken is None:
                        os.remove(path)
                    else:
                        with open(path, "wb") as f:
                            f.write(broken)
                    try:  # half a file can still be valid Python; then only the size tells
                        compile(broken if broken is not None else b"", path, "exec")
                        fails = broken is None
                    except SyntaxError:
                        fails = True
                    self._child(root, (
                        "import asyncio\n"
                        f"assert ({name!r} in mod._INTEGRITY.import_failures) == {fails}, "
                        "mod._INTEGRITY.import_failures\n"
                        "assert mod._INTEGRITY.status == 'broken', mod._INTEGRITY.snapshot()\n"
                        "r = asyncio.new_event_loop().run_until_complete(mod.Plugin().get_install_integrity())\n"
                        "assert r['status'] == 'broken' and r['label'].startswith('anygame.'), r\n"))
                    with open(path, "wb") as f:
                        f.write(body)


class HelperProcesses(unittest.TestCase):
    """Only processes this backend started from its own folders are closed."""

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("sleep"), "uses /proc")
    def test_find_and_stop_are_scoped(self):
        base = tempfile.mkdtemp(dir=TEST_ROOT)
        plugin, data = os.path.join(base, "plugins", "Nexus Mods"), os.path.join(base, "data", "Nexus Mods")
        os.makedirs(os.path.join(data, "tools"))
        os.makedirs(plugin)
        tool = os.path.join(data, "tools", "helper-tool")
        shutil.copy(shutil.which("sleep"), tool)
        ours = subprocess.Popen([tool, "60"])
        outside = subprocess.Popen([shutil.which("sleep"), "60"])
        # Same executable under our data folder, but not started by us (its
        # parent is gone, as a launcher Steam started would not be ours).
        orphan_pid_file = os.path.join(base, "orphan.pid")
        subprocess.run(["sh", "-c", f'"{tool}" 60 & echo $! > "{orphan_pid_file}"'], check=True)
        orphan = int(open(orphan_pid_file).read())
        try:
            time.sleep(0.3)
            found = forge_helpers.find(plugin, data)
            self.assertEqual([p["pid"] for p in found["close"]], [ours.pid])
            self.assertEqual(found["blockers"], [])
            left = forge_helpers.stop(found["close"], plugin, data)
            self.assertEqual(left, [])
            self.assertIsNotNone(ours.wait(5))
            self.assertIsNone(outside.poll(), "a process outside our folders was touched")
            os.kill(orphan, 0)  # still alive
        finally:
            for p in (ours, outside):
                p.kill()
                p.wait()
            try:
                os.kill(orphan, 9)
            except OSError:
                pass

    def test_a_recycled_pid_is_not_a_child(self):
        table = {10: (1, "/x/backend", 500), 20: (10, "/d/tool", 400), 30: (10, "/d/tool", 600),
                 40: (30, "/d/sub", 700)}
        self.assertEqual(forge_helpers.descendants(table, 10), {30, 40})

    def test_under_is_path_aware(self):
        self.assertTrue(forge_helpers.under("/a/Nexus Mods/bin/x.exe", "/a/Nexus Mods"))
        self.assertFalse(forge_helpers.under("/a/Nexus Mods 2/x.exe", "/a/Nexus Mods"))
        self.assertFalse(forge_helpers.under("", "/a"))

    def test_blockers_are_listed_not_closed(self):
        table = {10: (1, "/x/backend", 1), 50: (2, "/p/Nexus Mods/tool.exe", 5)}
        found = forge_helpers.find("/p/Nexus Mods", "/d/Nexus Mods", own_pid=10, table=table)
        self.assertEqual([b["pid"] for b in found["blockers"]], [50])
        self.assertEqual(found["close"], [])


class PrepareUpdate(unittest.TestCase):
    def setUp(self):
        self.plugin = main.Plugin()
        self.none = {"close": [], "blockers": []}

    def test_refuses_while_a_download_runs(self):
        main._DL_ACTIVE.add(4242)
        try:
            r = run(self.plugin.prepare_plugin_update())
        finally:
            main._DL_ACTIVE.discard(4242)
        self.assertEqual(r["reason"], "busy")
        self.assertIn("download", r["message"])

    def test_refuses_while_an_install_callable_runs(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def slow(self, *a, **k):
            started.set()
            await release.wait()
            return {"ok": True}

        async def scenario():
            with mock.patch.object(main.Plugin, "install_mod", main.functools.wraps(main.Plugin.install_mod)(slow)):
                main._wrap_jobs()
                task = asyncio.ensure_future(self.plugin.install_mod("skyrim", 1, 2))
                await started.wait()
                busy = await self.plugin.prepare_plugin_update()
                release.set()
                await task
                with mock.patch.object(main.forge_helpers, "find", return_value=self.none):
                    after = await self.plugin.prepare_plugin_update()
            return busy, after

        busy, after = run(scenario())
        self.assertEqual(busy["reason"], "busy")
        self.assertIn("install", busy["message"])
        self.assertTrue(after["ok"], after)

    def test_job_wrapping_keeps_the_signature_the_frontend_calls(self):
        sig = main.inspect.signature(main.Plugin.uninstall_mod)
        self.assertIn("game_domain", sig.parameters)
        self.assertTrue(hasattr(main.Plugin.install_mod, "__wrapped__"))
        self.assertFalse(main._JOB_CALLABLE.match("get_installed_mods"))
        self.assertTrue(main._JOB_CALLABLE.match("install_collection_direct"))

    def test_helpers_are_listed_first_and_closed_only_when_asked(self):
        found = {"close": [{"pid": 77, "exe": "/d/tools/7z.exe", "name": "7z.exe"}], "blockers": []}
        with mock.patch.object(main.forge_helpers, "find", return_value=found), \
                mock.patch.object(main.forge_helpers, "stop", return_value=[]) as stop:
            first = run(self.plugin.prepare_plugin_update())
            stop.assert_not_called()
            second = run(self.plugin.prepare_plugin_update(True))
        self.assertEqual((first["reason"], first["helpers"]), ("helpers_running", ["7z.exe"]))
        stop.assert_called_once()
        self.assertEqual(second, {"ok": True, "closed": ["7z.exe"]})

    def test_a_helper_that_will_not_close_stops_the_update(self):
        found = {"close": [{"pid": 77, "exe": "/d/x.exe", "name": "x.exe"}], "blockers": []}
        with mock.patch.object(main.forge_helpers, "find", return_value=found), \
                mock.patch.object(main.forge_helpers, "stop", return_value=["x.exe"]):
            r = run(self.plugin.prepare_plugin_update(True))
        self.assertEqual(r["reason"], "helpers_stuck")

    def test_a_blocker_we_did_not_start_is_never_killed(self):
        found = {"close": [], "blockers": [{"pid": 9, "exe": "/p/t.exe", "name": "t.exe"}]}
        with mock.patch.object(main.forge_helpers, "find", return_value=found), \
                mock.patch.object(main.forge_helpers, "stop") as stop:
            r = run(self.plugin.prepare_plugin_update(True))
        stop.assert_not_called()
        self.assertEqual(r["reason"], "blocked")

    def test_releases_the_integrity_thread_and_a_cwd_in_the_plugin_folder(self):
        checker = mock.Mock()
        here = os.getcwd()
        os.makedirs(main.decky.DECKY_PLUGIN_RUNTIME_DIR, exist_ok=True)
        try:
            os.chdir(main._PLUGIN_ROOT)
            with mock.patch.object(main, "_INTEGRITY", checker), \
                    mock.patch.object(main.forge_helpers, "find", return_value=self.none):
                r = run(self.plugin.prepare_plugin_update())
            self.assertTrue(r["ok"])
            checker.stop.assert_called_once()
            self.assertFalse(forge_helpers.under(os.getcwd(), main._PLUGIN_ROOT))
        finally:
            os.chdir(here)


class ReinstallTarget(unittest.TestCase):
    def _answers(self, mapping):
        async def fetch(url, timeout=300):
            for key, value in mapping.items():
                if url.split("?")[0].endswith(key):
                    if isinstance(value, Exception):
                        raise value
                    return json.dumps(value).encode()
            raise RuntimeError("HTTP 404")
        return mock.patch.object(main, "_fetch_bytes", fetch)

    def _entry(self, version, name):
        return {"version": version, "hash": "a" * 64, "artifact": main.FORK_RAW + name}

    def setUp(self):
        self.v = main.APP_VERSION

    def test_the_pinned_copy_of_this_build(self):
        with self._answers({f"update-{self.v}.json": self._entry(self.v, f"Nexus-Mods-{self.v}.zip")}):
            r = run(main.Plugin().get_reinstall_target())
        self.assertTrue(r["ok"] and r["same_version"], r)
        self.assertTrue(r["artifact"].endswith(f"Nexus-Mods-{self.v}.zip"))

    def test_the_newest_when_it_is_this_build(self):
        with self._answers({"update.json": self._entry(self.v, "Nexus-Mods.zip")}):
            r = run(main.Plugin().get_reinstall_target())
        self.assertTrue(r["same_version"])

    def test_the_newest_instead_saying_so(self):
        with self._answers({"update.json": self._entry("9.9.9-anygame.99", "Nexus-Mods.zip")}):
            r = run(main.Plugin().get_reinstall_target())
        self.assertFalse(r["same_version"])
        self.assertEqual(r["label"], "anygame.99")
        self.assertIn("no longer on the release channel", r["message"])

    def test_an_artifact_from_elsewhere_is_refused(self):
        evil = {"version": self.v, "hash": "a" * 64,
                "artifact": main.FORK_RAW + "../../../other/repo/main/x.zip"}
        with self._answers({f"update-{self.v}.json": evil, "update.json": evil}):
            r = run(main.Plugin().get_reinstall_target())
        self.assertFalse(r["ok"])


class IntegrityCallable(unittest.TestCase):
    def test_reports_the_build_the_manifest_names(self):
        checker = mock.Mock()
        checker.snapshot.return_value = {"status": "broken", "version": "1.21.32-anygame.67",
                                         "problems": ["missing: main.py"], "problem_count": 1,
                                         "import_failures": {}}
        with mock.patch.object(main, "_INTEGRITY", checker):
            r = run(main.Plugin().get_install_integrity())
        self.assertEqual((r["status"], r["label"]), ("broken", "anygame.67"))


if __name__ == "__main__":
    unittest.main()
