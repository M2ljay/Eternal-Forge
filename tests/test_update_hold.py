"""Holding Steam updates for modded games: state kept by the backend and
the appmanifest check for a waiting update."""
import asyncio
import os
import tempfile
import unittest
from unittest import mock

from test_backend import main


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class HoldTests(unittest.TestCase):
    def setUp(self):
        main._save_settings({"installed": {"cyberpunk2077": {"Mod": {"mode": "files"}}, "empty": {}}})
        self.plugin = main.Plugin()

    def test_state(self):
        st = run(self.plugin.get_update_hold())
        self.assertTrue(st["enabled"])
        self.assertEqual(st["domains"], ["cyberpunk2077"])
        run(self.plugin.note_update_hold(1091500, 0))
        run(self.plugin.note_update_hold(1091500, 2))  # the first previous value is kept
        self.assertEqual(run(self.plugin.get_update_hold())["held"], {"1091500": 0})
        run(self.plugin.release_update_hold(1091500))
        self.assertEqual(run(self.plugin.get_update_hold())["held"], {})
        run(self.plugin.set_update_hold_enabled(False))
        self.assertFalse(run(self.plugin.get_update_hold())["enabled"])

    def test_waiting(self):
        d = tempfile.mkdtemp()
        def manifest(app, flags, todo=0, done=0):
            p = os.path.join(d, f"appmanifest_{app}.acf")
            with open(p, "w") as f:
                f.write(f'"AppState"\n{{\n\t"appid"\t\t"{app}"\n\t"StateFlags"\t\t"{flags}"\n'
                        f'\t"BytesToDownload"\t\t"{todo}"\n\t"BytesDownloaded"\t\t"{done}"\n}}\n')
            return p
        paths = {1: manifest(1, 4), 2: manifest(2, 6), 3: manifest(3, 1028, 500, 100)}
        with mock.patch.object(main, "_find_in_libraries",
                               lambda name: paths.get(int(name.split("_")[1].split(".")[0]), "")):
            r = run(self.plugin.get_waiting_updates([1, 2, 3, 4]))
        self.assertEqual(r["waiting"], [2, 3])


if __name__ == "__main__":
    unittest.main()
