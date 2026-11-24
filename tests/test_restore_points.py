"""Restore points: made before mod changes, throttled, and the plan to go
back to one."""
import asyncio
import os
import shutil
import unittest
from unittest import mock

from test_backend import main


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def rec(mod_id, file_id, enabled=True, seq=1):
    return {"name": f"Mod {mod_id}", "mod_id": mod_id, "file_id": file_id, "version": "1",
            "mode": "files", "files": [], "install_seq": seq, **({} if enabled else {"enabled": False})}


class RestorePointTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(main.RP_DIR, ignore_errors=True)
        main._save_settings({"installed": {"rpgame": {"A": rec(1, 10), "B": rec(2, 20, seq=2)}}})
        self.plugin = main.Plugin()

    def tearDown(self):
        shutil.rmtree(main.RP_DIR, ignore_errors=True)

    def set_installed(self, recs):
        s = main._load_settings()
        s["installed"]["rpgame"] = recs
        main._save_settings(s)

    def test_plan(self):
        p = run(self.plugin.create_restore_point("rpgame", 0, ""))
        self.assertEqual(p["count"], 2)
        self.set_installed({"A": rec(1, 10, enabled=False), "C": rec(3, 30)})
        plan = run(self.plugin.get_restore_plan("rpgame", p["id"]))
        self.assertEqual([m["mod_id"] for m in plan["remove"]], [3])
        self.assertEqual([m["mod_id"] for m in plan["install"]], [2])
        self.assertEqual(plan["enable"], ["A"])
        self.assertEqual(plan["disable"], [])

    def test_throttle_and_keep(self):
        self.assertTrue(main._rp_create("rpgame", 0, "auto").get("id"))
        self.assertTrue(main._rp_create("rpgame", 0, "auto").get("skipped"))
        for _ in range(main.RP_KEEP + 3):
            main._rp_create("rpgame", 0, "manual", force=True)
        self.assertEqual(len(main._rp_list("rpgame")), main.RP_KEEP)

    def test_saves(self):
        saves = os.path.join(main.RP_DIR, "_fake_userdata", "123", "4242")
        os.makedirs(os.path.join(saves, "remote"))
        with open(os.path.join(saves, "remote", "slot1.sav"), "wb") as f:
            f.write(b"OLD")
        with mock.patch.object(main, "_rp_save_dirs", lambda app: [saves]):
            p = main._rp_create("rpgame", 4242, "x", force=True)
        self.assertEqual(p["saves"], 1)
        with open(os.path.join(saves, "remote", "slot1.sav"), "wb") as f:
            f.write(b"NEW")
        r = run(self.plugin.restore_point_saves("rpgame", p["id"]))
        self.assertEqual(r["files"], 1)
        with open(os.path.join(saves, "remote", "slot1.sav"), "rb") as f:
            self.assertEqual(f.read(), b"OLD")

    def test_bad_id(self):
        self.assertFalse(run(self.plugin.get_restore_plan("rpgame", "../x"))["ok"])


if __name__ == "__main__":
    unittest.main()
