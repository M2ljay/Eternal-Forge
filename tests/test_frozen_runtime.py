"""The plugin must import under Decky's frozen Windows Python, which bundles
only the standard-library modules Decky itself uses. decky_frozen_stdlib.txt
lists them, read from Decky v3.3.1's PluginLoader.exe as Playhub ships it
(PYZ archive, base_library.zip and top-level extension modules)."""

import os
import subprocess
import sys
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CHILD = textwrap.dedent(r'''
    import importlib.abc, os, sys, types
    root, listing = sys.argv[1], sys.argv[2]
    have = set(open(listing).read().split())
    # Registered at import time rather than shipped as files (collections
    # aliases _collections_abc into sys.modules).
    have |= {"collections.abc"}
    std = set(sys.stdlib_module_names)
    import importlib.machinery, sysconfig
    stdlib_dirs = tuple(os.path.realpath(sysconfig.get_path(k)) + os.sep for k in ("stdlib", "platstdlib"))
    class Block(importlib.abc.MetaPathFinder):
        """Hide a standard-library module Decky lacks; the plugin's own
        fallback copies (found outside the stdlib folders) stay importable."""
        def find_spec(self, name, path=None, target=None):
            if (name.split(".")[0] not in std or name in have or name in sys.builtin_module_names
                    or name.startswith("encodings.")):
                return None
            spec = importlib.machinery.PathFinder.find_spec(name, path)
            origin = os.path.realpath(spec.origin) if spec and spec.origin else ""
            if origin.startswith(stdlib_dirs) and os.sep + "site-packages" + os.sep not in origin:
                if path is None:
                    elsewhere = [p for p in sys.path
                                 if not (os.path.realpath(p) + os.sep).startswith(stdlib_dirs)
                                 or "site-packages" in p]
                    other = importlib.machinery.PathFinder.find_spec(name, elsewhere)
                    if other is not None:
                        return other
                raise ModuleNotFoundError(f"No module named {name!r} (not in Decky's frozen runtime)", name=name)
            return None
    for name in list(sys.modules):
        top = name.split(".")[0]
        if top in std and name not in have and name not in sys.builtin_module_names and not name.startswith("encodings"):
            sys.modules.pop(name, None)
    sys.meta_path.insert(0, Block())
    decky = types.ModuleType("decky")
    class _Log:
        def __getattr__(self, _):
            return lambda *a, **k: None
    decky.logger = _Log()
    for attr in ("DECKY_PLUGIN_SETTINGS_DIR", "DECKY_PLUGIN_RUNTIME_DIR", "DECKY_PLUGIN_LOG_DIR", "DECKY_PLUGIN_DIR",
                 "DECKY_HOME", "DECKY_USER_HOME", "DECKY_PLUGIN_NAME", "DECKY_PLUGIN_VERSION", "DECKY_USER"):
        setattr(decky, attr, os.path.join(root, ".frozen-sim", attr))
    decky.emit = lambda *a, **k: None
    sys.modules["decky"] = decky
    sys.modules["decky_plugin"] = decky
    sys.path[:0] = [os.path.join(root, "py_modules"), root]
    import importlib.util
    spec = importlib.util.spec_from_file_location("forge_main", os.path.join(root, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if len(sys.argv) > 3:  # a caller's own checks (test_install_integrity.py)
        exec(sys.argv[3], {"mod": mod})
        print("frozen import OK")
        sys.exit(0)
    import gamebanana, vr_feed
    text, _ = gamebanana.html_to_text("<p>Hello <b>there</b></p><ul><li>one</li></ul>")
    assert "Hello there" in text and "one" in text, text
    assert vr_feed.parse_atom('<feed><entry><title>VR &amp; you</title></entry></feed>')[0]["title"] == "VR & you"
    print("frozen import OK")
''')


class FrozenRuntimeImport(unittest.TestCase):
    def test_main_imports_with_only_deckys_stdlib(self):
        r = subprocess.run([sys.executable, "-I", "-c", CHILD, ROOT, os.path.join(HERE, "decky_frozen_stdlib.txt")],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        self.assertIn("frozen import OK", r.stdout)


if __name__ == "__main__":
    unittest.main()
