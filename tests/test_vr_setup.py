"""VR setups made by outside tools: recording what they change and keeping
the plugin's own file operations off those files."""
import asyncio
import os
import shutil
import tempfile
import time
import unittest

from test_backend import main

import vr_setup


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class VrSetupTests(unittest.TestCase):
    def setUp(self):
        self.root = main._game_dir("VR Game")
        shutil.rmtree(self.root, ignore_errors=True)
        os.makedirs(os.path.join(self.root, "Data"))
        self.write("Data/hud.dat", b"GAME")
        self.write("game.exe", b"EXE")
        self.game = {"appId": 91, "nexusDomain": "vrgame", "installDirName": "VR Game",
                     "processName": "game.exe", "engine": "generic", "modsSubdir": "mods"}
        main._save_settings({"experimental_games": {"91": self.game}})
        main._vr_rebuild()
        self.plugin = main.Plugin()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        main._vr_cancel("vrgame")
        main._vr_rebuild({})

    def write(self, rel, data, base=None):
        p = os.path.join(base or self.root, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)

    def read(self, rel):
        with open(os.path.join(self.root, *rel.split("/")), "rb") as f:
            return f.read()

    def install(self, name, files, mod_id=1):
        scratch = tempfile.mkdtemp()
        for rel, data in files.items():
            self.write(rel, data, scratch)
        return main._experimental_root_install(scratch, self.root, "mods", self.game, "vrgame", 91,
                                               {"name": name, "mod_id": mod_id, "file_id": mod_id * 10})

    def record(self, hub):
        self.assertTrue(run(self.plugin.start_vr_recording("vrgame", "VR Game", "mods"))["ok"])
        time.sleep(0.01)
        hub()
        r = run(self.plugin.finish_vr_recording("vrgame"))
        self.assertTrue(r["ok"], r)
        return r

    def test_records_added_and_changed(self):
        r = self.record(lambda: (self.write("dinput8.dll", b"VRDLL"), self.write("Data/hud.dat", b"VRHUD"),
                                 self.write("logs/run.log", b"noise")))
        self.assertEqual(r["protected"], 2)
        st = run(self.plugin.get_vr_setup("vrgame", "VR Game"))
        self.assertEqual(st["setup"]["count"], 2)
        self.assertEqual(st["setup"]["changed"], 0)
        self.assertFalse(st["recording"])

    def test_guard_keeps_vr_files(self):
        self.record(lambda: self.write("dinput8.dll", b"VRDLL"))
        p = os.path.join(self.root, "dinput8.dll")
        main.os.remove(p)
        self.assertTrue(os.path.isfile(p))
        main.shutil.move(p, os.path.join(self.root, "elsewhere.dll"))
        self.assertTrue(os.path.isfile(p))
        main.shutil.copy2(os.path.join(self.root, "game.exe"), p)
        self.assertEqual(self.read("dinput8.dll"), b"VRDLL")
        main.shutil.rmtree(self.root)
        self.assertEqual(self.read("dinput8.dll"), b"VRDLL")
        self.assertFalse(os.path.exists(os.path.join(self.root, "game.exe")))

    def test_mod_over_vr_file_and_back(self):
        self.record(lambda: self.write("dinput8.dll", b"VRDLL"))
        k = self.install("Loader", {"dinput8.dll": b"MODDLL"})
        self.assertEqual(self.read("dinput8.dll"), b"MODDLL")
        self.assertEqual(main._vr_replaced_by("vrgame", k), ["dinput8.dll"])
        run(self.plugin.uninstall_mod("vrgame", "VR Game", "mods", k, "folder"))
        self.assertEqual(self.read("dinput8.dll"), b"VRDLL")

    def test_uninstalling_mod_the_vr_tool_replaced(self):
        k = self.install("Loader", {"dinput8.dll": b"MODDLL"})
        self.record(lambda: self.write("dinput8.dll", b"VRDLL"))
        r = run(self.plugin.uninstall_mod("vrgame", "VR Game", "mods", k, "folder"))
        self.assertEqual(self.read("dinput8.dll"), b"VRDLL")
        self.assertIn("VR setup file", r.get("warning", ""))

    def test_mod_installed_while_recording_is_not_vr(self):
        def hub():
            self.write("dinput8.dll", b"VRDLL")
            self.install("Texture", {"Data/tex.dat": b"T"})
        r = self.record(hub)
        self.assertEqual(r["protected"], 1)

    def test_changed_after_update(self):
        self.record(lambda: self.write("dinput8.dll", b"VRDLL"))
        os.remove(os.path.join(self.root, "dinput8.dll"))
        st = run(self.plugin.get_vr_setup("vrgame", "VR Game"))
        self.assertEqual(st["setup"]["missing"], 1)

    def test_forget(self):
        self.record(lambda: self.write("dinput8.dll", b"VRDLL"))
        run(self.plugin.forget_vr_setup("vrgame"))
        main.os.remove(os.path.join(self.root, "dinput8.dll"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "dinput8.dll")))

    def test_orphan_reframework_kept(self):
        self.record(lambda: self.write("dinput8.dll", b"REFramework re2_fw_config.txt"))
        main._remove_orphan_reframework(self.game)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "dinput8.dll")))

    def test_rerecord_adds(self):
        self.record(lambda: self.write("a.dll", b"A"))
        r = self.record(lambda: self.write("b.dll", b"B"))
        self.assertEqual(r["protected"], 2)

    def test_name_clash(self):
        self.record(lambda: (self.write("dinput8.dll", b"V"), self.write("Data/hud.dat", b"X")))
        self.assertEqual(main._vr_name_clash("vrgame", ["Loader/dinput8.dll", "Data/hud.dat"]), ["dinput8.dll"])

    def test_hub_candidates(self):
        d = tempfile.mkdtemp()
        self.write("MRSURVIV0RS-VR-HUB.exe", b"x", d)
        self.write("MRSURVIV0RS-VR-HUB-0.9.95/MRSURVIV0RS VR HUB.exe", b"x", d)
        self.write("other.exe", b"x", d)
        self.assertEqual(len(vr_setup.hub_candidates([d])), 2)
        shutil.rmtree(d)

    def test_diff_noise(self):
        a, c, r = vr_setup.diff({"x.dll": [1, 1], "gone.ini": [1, 1]},
                                {"x.dll": [2, 2], "new.dll": [1, 1], "CrashDumps/a.dmp": [1, 1]})
        self.assertEqual((a, c, r), (["new.dll"], ["x.dll"], ["gone.ini"]))


if __name__ == "__main__":
    unittest.main()
