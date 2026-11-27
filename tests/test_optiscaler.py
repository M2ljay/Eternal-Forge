"""Forge: OptiScaler per game - the strict anti-cheat refusal, the release
and its hash, the GPU / DirectX checks, the ini, and an install / remove
round trip against fake files that must leave the game folder as it was."""
import asyncio
import hashlib
import io
import os
import shutil
import sys
import unittest
import zipfile
from unittest import mock

from test_backend import main, real_forge_resolver
from test_reloaded_ii import _pe

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
import optiscaler as osc  # noqa: E402
import forge_guard as fg  # noqa: E402


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


RDNA4 = [{"name": "AMD Radeon RX 9070 XT", "pnp": "PCI\\VEN_1002&DEV_7550&SUBSYS_0"}]
NVIDIA = [{"name": "NVIDIA GeForce RTX 4080", "pnp": "PCI\\VEN_10DE&DEV_2704"}]

SHIPPED_INI_OLD = (
    "[Upscalers]\n"
    "; Select Upscaler for Dx12 games\n"
    "; xess, fsr21, fsr22, fsr31 (also for FSR4), dlss - Default (auto) is xess\n"
    "Dx12Upscaler=auto\n")
SHIPPED_INI_NEW = (
    "[Upscalers]\n"
    "; Select Upscaler for Dx12 games\n"
    "; xess, fsr21, fsr22, ffx (FSR 2.3; 3.1; 4.x), dlss\n"
    "Dx12Upscaler=auto\n")


def release(digest=True, payload=b"", tag="v0.9.5", name="Optiscaler_0.9.5-final.20261115.7z"):
    asset = {"name": name, "size": len(payload),
             "browser_download_url": f"{osc.DOWNLOAD_PREFIX}{tag}/{name}"}
    if digest:
        asset["digest"] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return {"tag_name": tag, "prerelease": False, "draft": False, "assets": [asset]}


def archive(marker=b"opti", ini=SHIPPED_INI_OLD):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("OptiScaler.dll", b"OPTISCALER-" + marker)
        z.writestr("OptiScaler.ini", ini)
        z.writestr("libxess.dll", b"XESS-" + marker)
        z.writestr("amd_fidelityfx_dx12.dll", b"FFX-" + marker)
        z.writestr("D3D12_Optiscaler/D3D12Core.dll", b"AGILITY-" + marker)
        z.writestr("setup_windows.bat", "@echo off")
        z.writestr("!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt", "readme")
        z.writestr("Licenses/GPL-3.0.txt", "GPL")
    return buf.getvalue()


class RefusalRuleTests(unittest.TestCase):
    CAT = fg.load_catalog(main.FORGE_CATALOG)

    def v(self, app_id, folder=None, overrides=None):
        return fg.verdict(app_id, self.CAT, folder or {}, overrides or {})

    def test_kernel_anti_cheat_games_are_refused(self):
        for app in (1245620, 359550, 1938090, 553850):  # EAC, BattlEye, Ricochet, GameGuard
            r = osc.refusal(self.v(app), app, fg.ONLINE_ONLY)
            self.assertIsNotNone(r, app)
            self.assertEqual(r["error"], "Not allowed: anti-cheat (DLL injection)")
            self.assertTrue(r["anticheat_locked"])

    def test_the_mod_override_does_not_unlock_optiscaler(self):
        v = self.v(1245620, overrides={"1245620": {"at": 1}})
        self.assertFalse(v["locked"])  # ordinary mods are allowed now...
        r = osc.refusal(v, 1245620, fg.ONLINE_ONLY)
        self.assertEqual(r["reason"], "anticheat")  # ...OptiScaler is not
        self.assertNotIn("override_allowed", r)

    def test_folder_markers_refuse_a_game_no_list_knows(self):
        v = self.v(999001, folder={"marker": "EasyAntiCheat", "product": "Easy Anti-Cheat"})
        self.assertEqual(osc.refusal(v, 999001)["reason"], "anticheat")

    def test_online_competitive_games_are_refused(self):
        for app in (570, 1422450, 440):  # VAC only, not in the lock's list
            self.assertFalse(self.v(app)["detected"], app)
            self.assertEqual(osc.refusal(self.v(app), app, fg.ONLINE_ONLY)["reason"], "competitive", app)
        self.assertEqual(osc.refusal({"online_only": True}, 123)["reason"], "competitive")
        self.assertEqual(osc.refusal({}, 1172470, fg.ONLINE_ONLY)["reason"], "competitive")

    def test_an_unknown_game_is_refused(self):
        self.assertEqual(osc.refusal({}, 0)["reason"], "game_unknown")
        self.assertEqual(osc.refusal({}, "x")["reason"], "game_unknown")

    def test_the_frontend_shows_the_same_words(self):
        with open(os.path.join(os.path.dirname(__file__), "..", "src", "forgeRules.ts"), encoding="utf-8") as f:
            self.assertIn(f'OPTISCALER_REFUSED = "{osc.REFUSED_TEXT}"', f.read())

    def test_a_single_player_game_is_allowed(self):
        self.assertIsNone(osc.refusal(self.v(1091500), 1091500, fg.ONLINE_ONLY))  # Cyberpunk 2077


class ReleaseTests(unittest.TestCase):
    def test_picks_the_official_archive(self):
        rel = release(payload=b"x")
        rel["assets"].insert(0, {"name": "OptiScaler_debug.7z",
                                 "browser_download_url": osc.DOWNLOAD_PREFIX + "v0.9.5/OptiScaler_debug.7z"})
        rel["assets"].append({"name": "Optiscaler_0.9.5.zip",
                              "browser_download_url": osc.DOWNLOAD_PREFIX + "v0.9.5/Optiscaler_0.9.5.zip"})
        a = osc.pick_asset(rel)
        self.assertEqual(a["name"], "Optiscaler_0.9.5-final.20261115.7z")
        self.assertEqual(a["sha256"], hashlib.sha256(b"x").hexdigest())
        self.assertEqual(a["tag"], "v0.9.5")

    def test_refuses_other_hosts_and_pre_releases(self):
        rel = release(payload=b"x")
        rel["assets"][0]["browser_download_url"] = "https://example.com/Optiscaler.7z"
        self.assertIsNone(osc.pick_asset(rel))
        rel = release(payload=b"x")
        rel["prerelease"] = True
        self.assertIsNone(osc.pick_asset(rel))
        self.assertIsNone(osc.pick_asset({"assets": []}))

    def test_digest_and_version_parsing(self):
        self.assertEqual(osc.parse_digest("sha256:" + "A" * 64), "a" * 64)
        self.assertEqual(osc.parse_digest("md5:abc"), "")
        self.assertEqual(osc.version_of("v0.9.2a"), (0, 9, 2))
        self.assertGreater(osc.version_of("v0.10.0"), osc.version_of("v0.9.5"))


class HashPinTests(unittest.TestCase):
    A = {"tag": "v1", "name": "Optiscaler.7z", "sha256": ""}

    def test_github_digest_must_match(self):
        a = dict(self.A, sha256="ab" * 32)
        self.assertEqual(osc.check_hash({}, a, "ab" * 32)["how"], "verified")
        bad = osc.check_hash({}, a, "cd" * 32)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["how"], "digest_mismatch")
        # Accepting a change never overrides a published digest.
        self.assertFalse(osc.check_hash({}, a, "cd" * 32, accept_change=True)["ok"])

    def test_first_install_pins_and_a_change_is_refused(self):
        first = osc.check_hash({}, self.A, "11" * 32)
        self.assertEqual((first["ok"], first["how"]), (True, "pinned"))
        pins = {first["key"]: first["pin"]}
        self.assertEqual(osc.check_hash(pins, self.A, "11" * 32)["how"], "pinned_match")
        changed = osc.check_hash(pins, self.A, "22" * 32)
        self.assertFalse(changed["ok"])
        self.assertTrue(changed["hash_changed"])
        self.assertIn("changed", changed["error"])
        again = osc.check_hash(pins, self.A, "22" * 32, accept_change=True)
        self.assertEqual((again["ok"], again["how"], again["pin"]), (True, "repinned", "22" * 32))

    def test_pins_are_per_release_asset(self):
        pins = {"v1/Optiscaler.7z": "11" * 32}
        self.assertEqual(osc.check_hash(pins, dict(self.A, tag="v2"), "22" * 32)["how"], "pinned")


class GpuAndApiTests(unittest.TestCase):
    def test_rdna4_offers_fsr4_first(self):
        g = osc.gpu_info(RDNA4)
        self.assertTrue(g["rdna4"])
        c = osc.upscaler_choices(g)
        self.assertEqual(c["default"], "fsr4")
        self.assertEqual(c["choices"], ["fsr4", "fsr31", "xess"])
        self.assertTrue(osc.gpu_info([{"name": "AMD Radeon RX 9060 XT", "pnp": ""}])["rdna4"])
        self.assertTrue(osc.gpu_info([{"name": "AMD Radeon Graphics", "pnp": "PCI\\VEN_1002&DEV_7590"}])["rdna4"])

    def test_older_radeon_gets_fsr31_not_fsr4(self):
        c = osc.upscaler_choices(osc.gpu_info([{"name": "AMD Radeon RX 7900 XTX", "pnp": ""}]))
        self.assertNotIn("fsr4", c["choices"])
        self.assertEqual(c["default"], "fsr31")

    def test_nvidia_gets_dlss_passthrough_and_wins_over_integrated(self):
        g = osc.gpu_info([{"name": "Intel(R) UHD Graphics 770", "pnp": "PCI\\VEN_8086"}] + NVIDIA)
        self.assertEqual(g["vendor"], "nvidia")
        c = osc.upscaler_choices(g)
        self.assertEqual(c["default"], "dlss")
        self.assertIn("dlss", c["choices"])

    def test_arc_defaults_to_xess_and_unknown_to_fsr31(self):
        self.assertEqual(osc.upscaler_choices(osc.gpu_info([{"name": "Intel(R) Arc(TM) B580"}]))["default"], "xess")
        unknown = osc.upscaler_choices(osc.gpu_info([]))
        self.assertEqual(unknown["default"], "fsr31")
        self.assertEqual(unknown["choices"], ["fsr31", "xess"])

    def test_graphics_api_from_imports(self):
        self.assertEqual(osc.graphics_apis(True, ["kernel32.dll", "d3d12.dll", "dxgi.dll"])["apis"], ["dx12"])
        self.assertTrue(osc.graphics_apis(True, ["vulkan-1.dll"])["ok"])
        self.assertEqual(osc.graphics_apis(False, ["d3d11.dll"])["reason"], "32bit")
        self.assertEqual(osc.graphics_apis(True, ["d3d9.dll"])["reason"], "old_api")
        # Nothing graphics-related imported: d3d12 is loaded at run time.
        r = osc.graphics_apis(True, ["kernel32.dll"])
        self.assertEqual((r["ok"], r["reason"]), (True, "unknown"))
        self.assertTrue(osc.graphics_apis(True, [])["ok"])


class PlacementRuleTests(unittest.TestCase):
    def test_pick_exe(self):
        ue = [("Game.exe", 300_000), ("Game/Binaries/Win64/Game-Win64-Shipping.exe", 90_000_000),
              ("Engine/Binaries/Win64/CrashReportClient.exe", 20_000_000),
              ("Engine/Extras/Redist/en-us/UEPrereqSetup_x64.exe", 50_000_000)]
        self.assertEqual(osc.pick_exe(ue), "Game/Binaries/Win64/Game-Win64-Shipping.exe")
        plain = [("bin/x64/Witcher3.exe", 60_000_000), ("Launcher.exe", 80_000_000),
                 ("UnityCrashHandler64.exe", 2_000_000), ("_CommonRedist/vcredist_x64.exe", 90_000_000)]
        self.assertEqual(osc.pick_exe(plain), "bin/x64/Witcher3.exe")
        self.assertEqual(osc.pick_exe(plain, "Launcher.exe"), "Launcher.exe")
        self.assertEqual(osc.pick_exe(plain, "Witcher3"), "bin/x64/Witcher3.exe")
        self.assertEqual(osc.pick_exe([("../evil.exe", 1)]), "")

    def test_choose_proxy(self):
        self.assertEqual(osc.choose_proxy([]), {"name": "dxgi.dll", "replaces": False})
        self.assertEqual(osc.choose_proxy(["dxgi.dll"])["name"], "winmm.dll")
        # ReShade's dxgi.dll is never replaced, even when everything is taken.
        taken = ["dxgi.dll", "winmm.dll", "version.dll"]
        self.assertEqual(osc.choose_proxy(taken, reserved=["dxgi.dll"]),
                         {"name": "winmm.dll", "replaces": True})
        self.assertEqual(osc.choose_proxy(taken, backed_up=["dxgi.dll", "winmm.dll"])["name"], "version.dll")
        self.assertIn("error", osc.choose_proxy(taken, reserved=taken))
        self.assertEqual(osc.choose_proxy(["dxgi.dll"], requested="DXGI.dll"),
                         {"name": "dxgi.dll", "replaces": True})
        self.assertIn("error", osc.choose_proxy([], reserved=["dxgi.dll"], requested="dxgi.dll"))
        self.assertIn("error", osc.choose_proxy([], requested="d3d9.dll"))
        self.assertEqual(osc.next_proxy("dxgi.dll"), "winmm.dll")
        self.assertEqual(osc.next_proxy("version.dll"), "dxgi.dll")

    def test_plan_files(self):
        files = ["Opti/OptiScaler.dll", "Opti/OptiScaler.ini", "Opti/setup_windows.bat",
                 "Opti/!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt", "Opti/libxess.dll",
                 "Opti/D3D12_Optiscaler/D3D12Core.dll", "Other/stray.dll"]
        plan = dict(osc.plan_files(files, "winmm.dll"))
        self.assertEqual(plan["Opti/OptiScaler.dll"], "winmm.dll")
        self.assertEqual(plan["Opti/D3D12_Optiscaler/D3D12Core.dll"], "D3D12_Optiscaler/D3D12Core.dll")
        self.assertEqual(sorted(plan), ["Opti/D3D12_Optiscaler/D3D12Core.dll", "Opti/OptiScaler.dll",
                                        "Opti/libxess.dll"])
        self.assertEqual(osc.plan_files(["readme.txt"], "dxgi.dll"), [])


class IniTests(unittest.TestCase):
    def parse(self, text):
        out, sec = {}, None
        for line in text.split("\r\n"):
            if line.startswith("["):
                sec = out.setdefault(line.strip("[]"), {})
            elif "=" in line and not line.startswith(";"):
                k, v = line.split("=", 1)
                sec[k] = v
        return out

    def test_fsr4_on_a_0_9_release(self):
        ini = self.parse(osc.render_ini("fsr4", osc.upscaler_family(SHIPPED_INI_OLD), "v0.9.5"))
        self.assertEqual(ini["Upscalers"], {"Dx11Upscaler": "fsr31_12", "Dx12Upscaler": "fsr31",
                                            "VulkanUpscaler": "fsr31_12"})
        self.assertEqual(ini["FSR"], {"UpscalerIndex": "0"})
        self.assertEqual(ini["Menu"], {"DisableSplash": "true"})

    def test_fsr4_on_a_newer_release_uses_ffx(self):
        self.assertEqual(osc.upscaler_family(SHIPPED_INI_NEW), "ffx")
        ini = self.parse(osc.render_ini("fsr4", "ffx"))
        self.assertEqual(ini["Upscalers"]["Dx12Upscaler"], "ffx")
        self.assertEqual(ini["Upscalers"]["Dx11Upscaler"], "ffx_12")

    def test_fsr31_xess_and_dlss(self):
        self.assertEqual(self.parse(osc.render_ini("fsr31"))["FSR"], {"UpscalerIndex": "1"})
        self.assertEqual(self.parse(osc.render_ini("fsr31"))["Upscalers"]["Dx11Upscaler"], "fsr31")
        xess = self.parse(osc.render_ini("xess"))
        self.assertEqual(xess["Upscalers"]["Dx11Upscaler"], "xess_12")
        self.assertNotIn("FSR", xess)
        self.assertEqual(set(self.parse(osc.render_ini("dlss"))["Upscalers"].values()), {"dlss"})
        with self.assertRaises(ValueError):
            osc.render_ini("fsr5")

    def test_minimal_and_crlf(self):
        text = osc.render_ini("xess")
        self.assertNotIn("\n", text.replace("\r\n", ""))
        self.assertLess(len([ln for ln in text.split("\r\n") if "=" in ln]), 8)
        self.assertEqual(osc.upscaler_family(""), "fsr31")


class CrashRuleTests(unittest.TestCase):
    REC = {"files": [{"rel": "dxgi.dll"}], "installed_at": 1000}

    def test_quick_exit_or_crash_after_install_is_suspect(self):
        rec = osc.on_launch(self.REC, 2000)
        rec, ev = osc.on_exit(rec, 2020)
        self.assertEqual(ev, "suspect")
        self.assertEqual(rec["suspect"]["kind"], "quick")
        rec, ev = osc.on_exit(osc.on_launch(rec, 3000), 4000, crashed=True)
        self.assertEqual(ev, "suspect_again")
        self.assertEqual(rec["suspect"]["kind"], "crash")

    def test_a_clean_run_clears_it_and_stops_watching(self):
        rec, ev = osc.on_exit(osc.on_launch(self.REC, 2000), 2000 + osc.QUICK_EXIT_SECONDS)
        self.assertEqual(ev, "clean")
        self.assertTrue(rec["verified"])
        rec, ev = osc.on_exit(osc.on_launch(rec, 5000), 5005, crashed=True)
        self.assertEqual(ev, "")
        self.assertNotIn("suspect", rec)

    def test_a_launcher_handing_over_is_one_start(self):
        rec = osc.on_launch(self.REC, 2000)
        self.assertEqual(osc.on_launch(rec, 2010)["session_started"], 2000)
        self.assertEqual(osc.on_exit({}, 5), ({}, ""))


class BackendTests(unittest.TestCase):
    APP = 999777
    GAME = "OptiGame"
    EXE_DIR = ("Game", "Binaries", "Win64")

    def setUp(self):
        for p in (main.FORGE_STATE, main.FORGE_UPDATE_CACHE):
            try:
                os.remove(p)
            except OSError:
                pass
        main._FORGE_SCAN_CACHE.clear()
        main._OPTI_RELEASE.update({"at": 0.0, "release": None})
        main._OPTI_GPU.update({"at": 0.0, "info": None})
        shutil.rmtree(main.OPTI_CACHE, ignore_errors=True)
        self.real = real_forge_resolver()
        self.real.start()
        main._save_settings({"api_key": "test-key", "installed": {}})
        self.plugin = main.Plugin()
        self.root = os.path.join(main.STEAM_COMMON, self.GAME)
        self.base = os.path.join(self.root, *self.EXE_DIR)
        os.makedirs(self.base, exist_ok=True)
        with open(os.path.join(self.root, "Game.exe"), "wb") as f:
            f.write(_pe(["kernel32.dll"]))
        with open(os.path.join(self.base, "Game-Win64-Shipping.exe"), "wb") as f:
            f.write(_pe(["kernel32.dll", "d3d12.dll", "dxgi.dll"]) + b"\0" * 4096)
        with open(os.path.join(self.base, "libxess.dll"), "wb") as f:
            f.write(b"GAME-OWN-XESS")
        run(self.plugin.forge_register_games([
            ["optigame", self.APP, self.GAME], ["eldenring", 1245620, "ELDEN RING"],
            ["counterstrike2", 730, "Counter-Strike Global Offensive"], ["dota2", 570, "dota 2 beta"]]))
        self.payload = archive()
        self.downloads = []
        self.patches = [
            mock.patch.object(main, "_OPTI_GPU_ROWS", lambda: RDNA4),
            mock.patch.object(main, "_OPTI_FETCH", lambda: release(payload=self.payload)),
            mock.patch.object(main, "_OPTI_DOWNLOAD", self.fake_download),
            mock.patch.object(main, "_OPTI_EXTRACT", self.fake_extract),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.real.stop()
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(main.OPTI_CACHE, ignore_errors=True)

    def fake_download(self, url, dest):
        self.downloads.append(url)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(self.payload)
        return hashlib.sha256(self.payload).hexdigest()

    @staticmethod
    def fake_extract(arc, dest):
        with zipfile.ZipFile(arc) as z:
            z.extractall(dest)
        return True

    def snapshot(self):
        out = {}
        for cur, dirs, names in os.walk(self.root):
            rel = os.path.relpath(cur, self.root)
            out[rel + "/"] = None
            for n in names:
                with open(os.path.join(cur, n), "rb") as f:
                    out[os.path.join(rel, n)] = hashlib.sha256(f.read()).hexdigest()
        return out

    def install(self, **kw):
        kw.setdefault("game_domain", "optigame")
        return run(self.plugin.forge_optiscaler_install(self.APP, **kw))

    # ---- refusals --------------------------------------------------------

    def assert_refused(self, r, reason):
        self.assertFalse(r["ok"])
        self.assertTrue(r["not_allowed"])
        self.assertEqual(r["error"], "Not allowed: anti-cheat (DLL injection)")
        self.assertEqual(r["reason"], reason)

    def test_refused_for_kernel_anti_cheat_even_with_the_mod_override_on(self):
        self.assert_refused(run(self.plugin.forge_optiscaler_install(1245620, "fsr4", "eldenring")),
                            "anticheat")
        self.assertTrue(run(self.plugin.forge_set_anticheat_override(1245620, True, ""))["ok"])
        self.assert_refused(run(self.plugin.forge_optiscaler_install(1245620, "fsr4", "eldenring")),
                            "anticheat")
        st = run(self.plugin.forge_optiscaler_status(1245620, "eldenring"))
        self.assertFalse(st["allowed"])
        self.assertEqual(st["refusal"]["reason"], "anticheat")
        self.assertEqual(self.downloads, [])

    def test_refused_for_online_competitive_games(self):
        self.assert_refused(run(self.plugin.forge_optiscaler_install(730, "", "counterstrike2")),
                            "anticheat")  # CS2 is on the list (VAC) and online-only
        self.assert_refused(run(self.plugin.forge_optiscaler_install(570, "", "dota2")), "competitive")

    def test_refused_for_anti_cheat_files_in_the_folder(self):
        os.makedirs(os.path.join(self.root, "BattlEye"))
        main._FORGE_SCAN_CACHE.clear()
        self.assert_refused(self.install(), "anticheat")
        self.assertFalse(os.path.exists(os.path.join(self.base, "dxgi.dll")))

    def test_refused_for_an_unknown_game(self):
        self.assert_refused(run(self.plugin.forge_optiscaler_install(0)), "game_unknown")

    def test_refused_before_any_download_or_save_backup(self):
        with mock.patch.object(main, "_saves_backup") as backup:
            run(self.plugin.forge_optiscaler_install(1245620, "fsr4", "eldenring"))
        backup.assert_not_called()
        self.assertEqual(self.downloads, [])

    def test_changing_the_upscaler_is_refused_too(self):
        self.assert_refused(run(self.plugin.forge_optiscaler_set_upscaler(1245620, "fsr31")), "anticheat")

    def test_removal_is_never_refused(self):
        self.assertTrue(run(self.plugin.forge_optiscaler_remove(1245620))["ok"])

    # ---- install / remove ------------------------------------------------

    def test_round_trip_leaves_the_folder_exactly_as_it_was(self):
        with open(os.path.join(self.base, "dxgi.dll"), "wb") as f:
            f.write(b"SOMEONE-ELSES-DXGI")
        before = self.snapshot()
        r = self.install(upscaler="fsr4")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["proxy"], "winmm.dll")  # dxgi.dll was taken
        self.assertEqual(r["exe"], "Game/Binaries/Win64/Game-Win64-Shipping.exe")
        self.assertEqual(r["hash_how"], "verified")
        with open(os.path.join(self.base, "winmm.dll"), "rb") as f:
            self.assertEqual(f.read(), b"OPTISCALER-opti")
        with open(os.path.join(self.base, "libxess.dll"), "rb") as f:
            self.assertEqual(f.read(), b"XESS-opti")
        with open(os.path.join(self.base, "libxess.dll.nexusbak"), "rb") as f:
            self.assertEqual(f.read(), b"GAME-OWN-XESS")
        with open(os.path.join(self.base, "OptiScaler.ini"), encoding="utf-8", newline="") as f:
            ini = f.read()
        self.assertIn("Dx12Upscaler=fsr31\r\n", ini)
        self.assertIn("UpscalerIndex=0", ini)
        self.assertIn("DisableSplash=true", ini)
        for skipped in ("setup_windows.bat", "!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt",
                        "OptiScaler.dll"):
            self.assertFalse(os.path.exists(os.path.join(self.base, skipped)), skipped)
        self.assertTrue(os.path.isfile(os.path.join(self.base, "D3D12_Optiscaler", "D3D12Core.dll")))
        self.assertEqual(run(self.plugin.forge_optiscaler_installed())["app_ids"], [self.APP])

        out = run(self.plugin.forge_optiscaler_remove(self.APP))
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["restored"], ["libxess.dll"])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(run(self.plugin.forge_optiscaler_status(self.APP, "optigame"))["installed"]["installed"])

    def test_a_replaced_proxy_is_backed_up_and_put_back(self):
        for n in osc.PROXY_NAMES:
            with open(os.path.join(self.base, n), "wb") as f:
                f.write(b"ORIGINAL-" + n.encode())
        before = self.snapshot()
        r = self.install(upscaler="fsr31")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["proxy"], "dxgi.dll")
        self.assertIn("dxgi.dll", r["replaced"])
        self.assertTrue(run(self.plugin.forge_optiscaler_remove(self.APP))["ok"])
        self.assertEqual(self.snapshot(), before)

    def test_reshade_keeps_its_dxgi(self):
        main._save_settings({"api_key": "k", "installed": {}, "reshade": {"optigame": {
            "dll": "Game/Binaries/Win64/dxgi.dll", "install_dir": self.GAME}}})
        with open(os.path.join(self.base, "dxgi.dll"), "wb") as f:
            f.write(b"RESHADE")
        r = self.install(proxy="dxgi.dll")
        self.assertFalse(r["ok"])
        self.assertIn("ReShade", r["error"])
        self.assertTrue(self.install()["ok"])
        with open(os.path.join(self.base, "dxgi.dll"), "rb") as f:
            self.assertEqual(f.read(), b"RESHADE")

    def test_another_mods_backup_is_never_overwritten(self):
        with open(os.path.join(self.base, "libxess.dll.nexusbak"), "wb") as f:
            f.write(b"OTHER-MODS-BACKUP")
        before = self.snapshot()
        r = self.install()
        self.assertFalse(r["ok"])
        self.assertIn("backup from another mod", r["error"])
        self.assertEqual(self.snapshot(), before)

    def test_reinstall_with_another_name_and_update_keep_one_install(self):
        self.assertTrue(self.install()["ok"])
        r = self.install(proxy="version.dll")
        self.assertTrue(r["ok"], r)
        self.assertFalse(os.path.exists(os.path.join(self.base, "dxgi.dll")))
        self.assertTrue(os.path.exists(os.path.join(self.base, "version.dll")))
        # Cached archive reused: one download for three installs.
        self.assertEqual(r["proxy"], "version.dll")
        self.assertTrue(self.install(upscaler="xess")["ok"])
        self.assertEqual(len(self.downloads), 1)
        self.assertTrue(os.path.exists(os.path.join(self.base, "version.dll")))  # name kept

    def test_set_upscaler_rewrites_only_the_ini(self):
        self.assertTrue(self.install(upscaler="fsr4")["ok"])
        r = run(self.plugin.forge_optiscaler_set_upscaler(self.APP, "xess"))
        self.assertTrue(r["ok"], r)
        with open(os.path.join(self.base, "OptiScaler.ini"), encoding="utf-8") as f:
            self.assertIn("Dx12Upscaler=xess", f.read())
        self.assertFalse(run(self.plugin.forge_optiscaler_set_upscaler(self.APP, "dlss"))["ok"])  # no NVIDIA
        self.assertTrue(run(self.plugin.forge_optiscaler_remove(self.APP))["ok"])  # new ini hash recorded

    def test_a_file_changed_since_install_is_left_and_named(self):
        self.assertTrue(self.install()["ok"])
        with open(os.path.join(self.base, "libxess.dll"), "wb") as f:
            f.write(b"A-LATER-MOD")
        out = run(self.plugin.forge_optiscaler_remove(self.APP))
        self.assertFalse(out["ok"])
        self.assertEqual(out["kept"], ["libxess.dll"])
        self.assertEqual(out["not_restored"], ["libxess.dll"])
        with open(os.path.join(self.base, "libxess.dll"), "rb") as f:
            self.assertEqual(f.read(), b"A-LATER-MOD")
        self.assertFalse(os.path.exists(os.path.join(self.base, "dxgi.dll")))
        self.assertEqual(run(self.plugin.forge_optiscaler_installed())["app_ids"], [self.APP])

    def test_fsr4_needs_rdna4_and_32bit_games_are_refused(self):
        with mock.patch.object(main, "_OPTI_GPU_ROWS", lambda: NVIDIA):
            r = self.install(upscaler="fsr4")
        self.assertFalse(r["ok"])
        self.assertIn("RDNA 4", r["error"])
        main._OPTI_GPU.update({"at": 0.0, "info": None})
        with open(os.path.join(self.base, "Game-Win64-Shipping.exe"), "wb") as f:
            f.write(_pe(["d3d11.dll"], is64=False))
        r = self.install()
        self.assertFalse(r["ok"])
        self.assertIn("64-bit", r["error"])
        self.assertEqual(self.downloads, [])

    def test_save_backup_runs_before_any_file_is_placed(self):
        seen = []

        async def backup(app_id, game_name="", reason="", required=False):
            seen.append((app_id, os.path.exists(os.path.join(self.base, "dxgi.dll"))))
            return {"ok": True, "ran": True}

        with mock.patch.object(main, "_saves_backup", backup):
            r = self.install()
        self.assertTrue(r["ok"])
        self.assertEqual(seen, [(self.APP, False)])
        self.assertTrue(r["save_backup"]["ok"])

    # ---- hashes ----------------------------------------------------------

    def test_a_digest_mismatch_is_refused_and_nothing_placed(self):
        before = self.snapshot()
        with mock.patch.object(main, "_OPTI_FETCH", lambda: release(payload=b"something else")):
            r = self.install()
        self.assertFalse(r["ok"])
        self.assertEqual(r["how"], "digest_mismatch")
        self.assertEqual(self.snapshot(), before)

    def test_without_a_digest_the_first_hash_is_pinned_and_a_change_warns(self):
        with mock.patch.object(main, "_OPTI_FETCH", lambda: release(digest=False, payload=self.payload)):
            r = self.install()
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["hash_how"], "pinned")
            self.assertTrue(run(self.plugin.forge_optiscaler_remove(self.APP))["ok"])
            before = self.snapshot()
            self.payload = archive(marker=b"tampered")
            shutil.rmtree(main.OPTI_CACHE, ignore_errors=True)
            r = self.install()
            self.assertFalse(r["ok"])
            self.assertTrue(r["hash_changed"])
            self.assertEqual(self.snapshot(), before)
            r = self.install(accept_new_hash=True)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["hash_how"], "repinned")

    # ---- failure safety --------------------------------------------------

    def test_a_quick_exit_after_install_offers_removal(self):
        self.assertTrue(self.install()["ok"])
        rec = main._opti_record(self.APP)
        main._opti_set_record(self.APP, dict(rec, installed_at=rec["installed_at"] - 100))
        run(self.plugin.forge_optiscaler_launch(self.APP))
        r = run(self.plugin.forge_optiscaler_exit(self.APP))
        self.assertEqual((r["event"], r["notify"]), ("suspect", True))
        st = run(self.plugin.forge_optiscaler_status(self.APP, "optigame"))
        self.assertEqual(st["installed"]["suspect"]["kind"], "quick")
        self.assertTrue(run(self.plugin.forge_optiscaler_remove(self.APP))["ok"])

    def test_keep_it_stops_the_watch(self):
        self.assertTrue(self.install()["ok"])
        run(self.plugin.forge_optiscaler_dismiss(self.APP))
        run(self.plugin.forge_optiscaler_launch(self.APP))
        self.assertEqual(run(self.plugin.forge_optiscaler_exit(self.APP))["event"], "")

    def test_status_reports_updates(self):
        self.assertTrue(self.install()["ok"])
        with mock.patch.object(main, "_OPTI_FETCH", lambda: release(payload=b"", tag="v0.9.6")):
            main._OPTI_RELEASE.update({"at": 0.0, "release": None})
            st = run(self.plugin.forge_optiscaler_status(self.APP, "optigame", "", True))
        self.assertTrue(st["update_available"])
        self.assertEqual(st["latest"], "v0.9.6")


if __name__ == "__main__":
    unittest.main()
