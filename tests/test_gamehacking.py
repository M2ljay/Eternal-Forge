"""GameHacking.org PS2 cheats (anygame.74) against a fake site: robots.txt
handling, the request budget and spacing, the User-Agent, caching, matching,
back-off and the session stop, bot checks and the kill switch."""
import asyncio
import os
import shutil
import tempfile
import unittest
from unittest import mock

from test_backend import main

import gamehacking as gh


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


LIST_A = """<html><body><table><tbody>
<tr><th>K</th></tr>
<tr><td><a href="/game/1001">Kingdom Hearts</a></td><td>SLUS-20370</td></tr>
<tr><td><a href="/game/1002">Kingdom Hearts II</a></td><td>SLUS-21005</td></tr>
<tr><td><a href="/game/1003">Ratchet &amp; Clank</a></td><td>SCUS-97199, SCES-50916</td></tr>
</tbody></table>
<a href="/system/ps2/all/A">A</a><a href="/system/ps2/all/O">O</a><a href="/system/ps2/all/K">K</a>
</body></html>"""

LIST_O = """<table><tbody>
<tr><td><a href="/game/2001">Okami</a></td><td>SLUS-21115</td></tr>
<tr><td><a href="/game/2002">Okami (PAL)</a></td><td>SLES-54439</td></tr>
</tbody></table>"""

GAME_PAGE = """<form><input type="hidden" name="sysID" value="7"><input type="hidden" name="gamID" value="2001">
<select name="format"><option value="Text">Text</option><option value="Pnach">PCSX2 (pnach)</option></select></form>"""

PNACH = b"gametitle=Okami\n//Infinite Health\npatch=1,EE,20123456,extended,000003E7\n"


class FakeSite:
    def __init__(self, robots="User-agent: *\nDisallow: /admin/\n", export=PNACH, game_page=GAME_PAGE):
        self.robots, self.export, self.game_page = robots, export, game_page
        self.calls = []
        self.status = {}

    async def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        path = url.replace("https://gamehacking.org", "")
        if path in self.status:
            st = self.status[path]
            return st[0], st[1], st[2]
        if path == "/robots.txt":
            return (404, {}, b"") if self.robots is None else (200, {}, self.robots.encode())
        if path == "/system/ps2/all":
            return 200, {}, LIST_A.encode()
        if path == "/system/ps2/all/O":
            return 200, {}, LIST_O.encode()
        if path.startswith("/game/"):
            return 200, {}, self.game_page.encode()
        if path == "/inc/sub.exportCodes.php" and method == "POST":
            return 200, {"Content-Disposition": 'attachment; filename="SLUS21115.pnach"'}, self.export
        return 404, {}, b""


class Clock:
    def __init__(self):
        self.t = 1_000_000.0
        self.slept = []

    def __call__(self):
        return self.t

    async def sleep(self, s):
        self.slept.append(s)
        self.t += s


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.clock = Clock()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def client(self, site):
        return gh.Client(site, "1.21.40-anygame.74", self.tmp, clock=self.clock, sleep=self.clock.sleep)


class RobotsTests(unittest.TestCase):
    def test_longest_rule_wins_and_allow_breaks_ties(self):
        g = gh.parse_robots("User-agent: *\nDisallow: /game/\nAllow: /game/public\n")
        self.assertFalse(gh.robots_allows(g, "Forge", "/game/1"))
        self.assertTrue(gh.robots_allows(g, "Forge", "/game/public/1"))
        self.assertTrue(gh.robots_allows(g, "Forge", "/system/ps2/all"))

    def test_our_own_group_beats_star(self):
        g = gh.parse_robots("User-agent: *\nDisallow: /\n\nUser-agent: Forge\nDisallow: /inc/\n")
        self.assertTrue(gh.robots_allows(g, "Forge", "/system/ps2/all"))
        self.assertFalse(gh.robots_allows(g, "Forge", "/inc/sub.exportCodes.php"))

    def test_wildcards_and_end_anchor(self):
        g = gh.parse_robots("User-agent: *\nDisallow: /*.php$\n")
        self.assertFalse(gh.robots_allows(g, "Forge", "/inc/sub.exportCodes.php"))
        self.assertTrue(gh.robots_allows(g, "Forge", "/inc/sub.exportCodes.php?x=1"))

    def test_empty_disallow_allows_everything(self):
        self.assertTrue(gh.robots_allows(gh.parse_robots("User-agent: *\nDisallow:\n"), "Forge", "/inc/x.php"))


class PageTests(unittest.TestCase):
    def test_list_rows_serials_and_pages(self):
        got = gh.parse_list(LIST_A)
        self.assertEqual(got["games"][0], {"title": "Kingdom Hearts", "href": "/game/1001", "serial": "SLUS-20370"})
        self.assertEqual([p["label"] for p in got["pages"]], ["A", "O", "K"])

    def test_game_page_form(self):
        self.assertEqual(gh.parse_game_page(GAME_PAGE), {"sysID": "7", "gamID": "2001", "format": "Pnach"})
        self.assertEqual(gh.parse_game_page("<form><input name='sysID' value='7'></form>"), {})

    def test_pnach_check(self):
        self.assertTrue(gh.valid_pnach(PNACH))
        self.assertFalse(gh.valid_pnach(b"<!DOCTYPE html><html>"))
        self.assertFalse(gh.valid_pnach(b"just text"))


class MatchTests(unittest.TestCase):
    GAMES = gh.parse_list(LIST_A)["games"]

    def test_serial_first_in_any_spelling(self):
        self.assertEqual(gh.match_games(self.GAMES, "SLUS_210.05", "")[0]["title"], "Kingdom Hearts II")
        self.assertEqual(gh.match_games(self.GAMES, "SCES-50916", "x")[0]["title"], "Ratchet & Clank")

    def test_then_title(self):
        got = gh.match_games(self.GAMES, "", "Kingdom Hearts (USA)")
        self.assertEqual(got[0]["title"], "Kingdom Hearts")
        self.assertEqual(got[0]["score"], 80)
        self.assertEqual(len(got), 2, "the sequel is offered too; the user picks")

    def test_letter_page(self):
        pages = gh.parse_list(LIST_A)["pages"]
        self.assertEqual(gh.page_for(pages, "Okami")["href"], "/system/ps2/all/O")
        self.assertIsNone(gh.page_for(pages, "Zone of the Enders"))


class ClientTests(Base):
    def test_find_reads_robots_first_then_at_most_two_list_pages(self):
        site = FakeSite()
        got = run(self.client(site).find("SLUS-21115", "Okami"))
        self.assertEqual(got[0]["href"], "/game/2001")
        self.assertEqual([c[1].replace("https://gamehacking.org", "") for c in site.calls],
                         ["/robots.txt", "/system/ps2/all", "/system/ps2/all/O"])

    def test_honest_user_agent_and_spacing(self):
        site = FakeSite()
        run(self.client(site).find("SLUS-21115", "Okami"))
        for c in site.calls:
            self.assertEqual(c[2]["User-Agent"], "Forge/1.21.40-anygame.74 (personal use)")
            self.assertNotIn("Cookie", c[2])
        self.assertTrue(all(s <= gh.MIN_SPACING for s in self.clock.slept))
        self.assertEqual(len(self.clock.slept), 2, "every request after the first waited")

    def test_results_are_cached_a_week(self):
        site = FakeSite()
        c = self.client(site)
        run(c.find("SLUS-21115", "Okami"))
        n = len(site.calls)
        run(c.find("SLUS-21115", "Okami"))
        self.assertEqual(len(site.calls), n, "second press: no request")
        fresh = self.client(site)  # a new session reads the same cache folder
        run(fresh.find("SLUS-21115", "Okami"))
        self.assertEqual(len(site.calls), n)
        self.clock.t += gh.CACHE_TTL + 1
        run(fresh.find("SLUS-21115", "Okami"))
        self.assertGreater(len(site.calls), n)

    def test_pnach_export_uses_the_pages_own_form(self):
        site = FakeSite()
        got = run(self.client(site).pnach("/game/2001", "SLUS21115"))
        self.assertEqual(got["name"], "SLUS21115.pnach")
        self.assertIn("patch=1,EE", got["data"])
        post = [c for c in site.calls if c[0] == "POST"][0]
        self.assertIn("format=Pnach", post[3])
        self.assertIn("sysID=7", post[3])
        self.assertIn("gamID=2001", post[3])
        self.assertEqual(post[2]["Referer"], "https://gamehacking.org/game/2001")
        self.assertLessEqual(len(site.calls), gh.MAX_REQUESTS_PER_ACTION)

    def test_robots_disallow_means_no_request_and_a_reason(self):
        site = FakeSite(robots="User-agent: *\nDisallow: /inc/\n")
        with self.assertRaises(gh.Unavailable) as cm:
            run(self.client(site).pnach("/game/2001", "X"))
        self.assertEqual(cm.exception.reason, "robots")
        self.assertFalse(any(c[0] == "POST" for c in site.calls))

    def test_no_robots_txt_allows(self):
        site = FakeSite(robots=None)
        self.assertTrue(run(self.client(site).find("SLUS-21115", "Okami")))

    def test_bot_check_falls_back(self):
        site = FakeSite()
        site.status["/system/ps2/all"] = (503, {}, b"<html>Just a moment... cf-chl</html>")
        with self.assertRaises(gh.Unavailable) as cm:
            run(self.client(site).find("SLUS-21115", "Okami"))
        self.assertIn(cm.exception.reason, ("bot_check", "busy"))

    def test_html_instead_of_pnach_falls_back(self):
        site = FakeSite(export=b"<!DOCTYPE html><html>log in</html>")
        with self.assertRaises(gh.Unavailable) as cm:
            run(self.client(site).pnach("/game/2001", "X"))
        self.assertEqual(cm.exception.reason, "not_pnach")

    def test_429_backs_off_with_retry_after(self):
        site = FakeSite()
        site.status["/system/ps2/all"] = (429, {"Retry-After": "600"}, b"")
        c = self.client(site)
        with self.assertRaises(gh.Unavailable):
            run(c.find("SLUS-21115", "Okami"))
        n = len(site.calls)
        with self.assertRaises(gh.Unavailable) as cm:
            run(c.find("SLUS-21115", "Okami"))
        self.assertEqual(cm.exception.reason, "backoff")
        self.assertEqual(len(site.calls), n, "no request while backing off")
        self.clock.t += 601
        del site.status["/system/ps2/all"]
        self.assertTrue(run(c.find("SLUS-21115", "Okami")))

    def test_repeated_failures_stop_for_the_session(self):
        site = FakeSite()
        site.status["/system/ps2/all"] = (500, {}, b"")
        c = self.client(site)
        for _ in range(gh.MAX_FAILURES):
            with self.assertRaises(gh.Unavailable):
                run(c.find("SLUS-21115", "Okami"))
            self.clock.t += gh.MAX_BACKOFF_SECONDS + 1
        n = len(site.calls)
        with self.assertRaises(gh.Unavailable) as cm:
            run(c.find("SLUS-21115", "Okami"))
        self.assertEqual(cm.exception.reason, "stopped")
        self.assertEqual(len(site.calls), n)

    def test_budget_caps_requests_per_press(self):
        site = FakeSite()
        c = self.client(site)
        budget = [2]
        run(c._request(budget, "GET", "/system/ps2/all"))  # robots + list
        with self.assertRaises(gh.Unavailable) as cm:
            run(c._request(budget, "GET", "/system/ps2/all/O"))
        self.assertEqual(cm.exception.reason, "budget")

    def test_only_the_site_and_game_pages(self):
        c = self.client(FakeSite())
        with self.assertRaises(gh.Unavailable):
            run(c.pnach("https://evil.example/game/1", "X"))
        with self.assertRaises(gh.Unavailable):
            run(c.pnach("/inc/sub.exportCodes.php", "X"))

    def test_kill_switch(self):
        site = FakeSite()
        with mock.patch.object(gh, "GAMEHACKING_ENABLED", False):
            with self.assertRaises(gh.Unavailable) as cm:
                run(self.client(site).find("SLUS-21115", "Okami"))
        self.assertEqual(cm.exception.reason, "removed")
        self.assertEqual(site.calls, [])


class GlueTests(Base):
    def setUp(self):
        super().setUp()
        self.home = os.path.join(self.tmp, "home")
        self.downloads = os.path.join(self.home, "Downloads")
        os.makedirs(self.downloads)
        self.settings = {}
        self.patches = [
            mock.patch.dict(os.environ, {"USERPROFILE": self.home}),
            mock.patch.object(main, "_load_settings", lambda: self.settings),
            mock.patch.object(main, "_save_settings", lambda s: self.settings.update(s)),
        ]
        for p in self.patches:
            p.start()
        main._ROM_STORE = main.rom_mods.RecordStore(os.path.join(self.tmp, "rom.json"))
        self.site = FakeSite()
        main._GH_CLIENT = gh.Client(self.site, "t", os.path.join(self.tmp, "cache"), clock=self.clock, sleep=self.clock.sleep)
        self.plugin = main.Plugin()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        main._GH_CLIENT = None
        main._ROM_STORE = None
        super().tearDown()

    def test_find_and_stage_into_downloads_under_its_own_name(self):
        r = run(self.plugin.forge_gh_find("SLUS-21115", "Okami"))
        self.assertTrue(r["ok"], r)
        s = run(self.plugin.forge_gh_stage(1, r["candidates"][0]["href"], "SLUS-21115", self.downloads))
        self.assertTrue(s["ok"], s)
        self.assertEqual(s["entry"], "SLUS21115.pnach")
        self.assertTrue(os.path.isfile(os.path.join(self.downloads, "SLUS21115.pnach")))
        self.assertIn(s["entry"], main._rom_store().staged())

    def test_user_switch_off_refuses_with_the_link(self):
        run(self.plugin.forge_gh_set_enabled(False))
        r = run(self.plugin.forge_gh_find("SLUS-21115", "Okami"))
        self.assertEqual((r["ok"], r["reason"]), (False, "off"))
        self.assertTrue(r["link"].startswith("https://gamehacking.org/"))
        self.assertEqual(self.site.calls, [])
        st = run(self.plugin.forge_gh_status())
        self.assertEqual((st["available"], st["enabled"]), (True, False))

    def test_removed_build_refuses_everything(self):
        with mock.patch.object(gh, "GAMEHACKING_ENABLED", False):
            self.assertEqual(run(self.plugin.forge_gh_find("S", "T"))["reason"], "removed")
            self.assertEqual(run(self.plugin.forge_gh_stage(1, "/game/1", "S", self.downloads))["reason"], "removed")
            self.assertFalse(run(self.plugin.forge_gh_status())["available"])
        self.assertEqual(self.site.calls, [])

    def test_refusal_carries_the_link_out(self):
        self.site.robots = "User-agent: *\nDisallow: /\n"
        r = run(self.plugin.forge_gh_find("SLUS-21115", "Okami"))
        self.assertEqual(r["reason"], "robots")
        self.assertIn("robots.txt", r["message"])
        self.assertEqual(r["link"], gh.LINK_OUT)


if __name__ == "__main__":
    unittest.main()
