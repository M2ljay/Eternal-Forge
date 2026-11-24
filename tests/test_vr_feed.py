"""New VR mod releases: feed parsing, VR detection, and the seen/new list."""
import asyncio
import time
import unittest
from unittest import mock

from test_backend import main

import vr_feed

ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/MrSurviv0r/MRSURVIV0R-S-VR-HUB/releases</id>
  <title>Release notes from MRSURVIV0R-S-VR-HUB</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.9.96</id>
    <updated>2026-11-20T18:04:11Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/MrSurviv0r/MRSURVIV0R-S-VR-HUB/releases/tag/v0.9.96"/>
    <title>VR HUB 0.9.96</title>
    <content type="html">&lt;p&gt;Added Cyberpunk 2077 fixes and &lt;b&gt;Resident Evil 2&lt;/b&gt; support. Portal 2 updated.&lt;/p&gt;</content>
    <author><name>MrSurviv0r</name></author>
  </entry>
</feed>"""


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class FeedTests(unittest.TestCase):
    def test_parse_atom(self):
        e = vr_feed.parse_atom(ATOM)
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["title"], "VR HUB 0.9.96")
        self.assertTrue(e[0]["url"].endswith("v0.9.96"))
        self.assertGreater(e[0]["date"], 1_700_000_000)
        self.assertIn("Resident Evil 2 support", e[0]["text"])
        self.assertEqual(vr_feed.parse_atom("not xml"), [])

    def test_games_named(self):
        text = vr_feed.parse_atom(ATOM)[0]["text"]
        got = vr_feed.mentioned_games(text, ["Cyberpunk 2077", "Resident Evil 2", "DOOM", "Portal"])
        self.assertEqual(got, ["Cyberpunk 2077", "Resident Evil 2"])

    def test_is_vr(self):
        self.assertTrue(vr_feed.is_vr("Cyberpunk VR Fixes"))
        self.assertTrue(vr_feed.is_vr("Camera mod", "UEVR profile with motion controls"))
        self.assertTrue(vr_feed.is_vr("Full 6DoF"))
        self.assertFalse(vr_feed.is_vr("VRAM optimiser", "Lower VRR flicker"))
        self.assertFalse(vr_feed.is_vr("Better textures"))

    def test_repo_slug(self):
        self.assertEqual(vr_feed.repo_slug("https://github.com/praydog/UEVR"), "praydog/UEVR")
        self.assertEqual(vr_feed.repo_slug("praydog/UEVR/"), "praydog/UEVR")
        self.assertEqual(vr_feed.repo_slug("https://github.com/praydog/UEVR.git"), "praydog/UEVR")
        self.assertEqual(vr_feed.repo_slug("not a link"), "")


class ReleasesTests(unittest.TestCase):
    def setUp(self):
        main._save_settings({})
        self.plugin = main.Plugin()

    def collect(self, ids):
        async def fake():
            return {"items": [{"id": i, "source": "hub", "title": i, "sub": "", "url": "", "date": int(time.time()),
                               "games": []} for i in ids], "errors": []}
        return mock.patch.object(main, "_vr_collect", fake)

    def test_first_check_is_not_news_then_new_is_marked(self):
        with self.collect(["a", "b"]):
            r = run(self.plugin.get_vr_releases(True))
        self.assertEqual(r["new"], 0)
        with self.collect(["c", "a", "b"]):
            r = run(self.plugin.get_vr_releases(True))
        self.assertEqual([i["id"] for i in r["items"] if i["new"]], ["c"])
        run(self.plugin.mark_vr_releases_seen())
        r = run(self.plugin.get_vr_releases(False))
        self.assertEqual(r["new"], 0)

    def test_cached_without_force(self):
        with self.collect(["a"]):
            run(self.plugin.get_vr_releases(True))
        with self.collect(["z"]):
            r = run(self.plugin.get_vr_releases(False))
        self.assertEqual([i["id"] for i in r["items"]], ["a"])

    def test_repos(self):
        self.assertFalse(run(self.plugin.add_vr_repo("nonsense"))["ok"])
        self.assertEqual(run(self.plugin.add_vr_repo("https://github.com/praydog/UEVR"))["repo"], "praydog/UEVR")
        run(self.plugin.add_vr_repo("praydog/uevr"))
        self.assertEqual(main._load_settings()["vr_feed"]["repos"], ["praydog/UEVR"])
        run(self.plugin.remove_vr_repo("praydog/UEVR"))
        self.assertEqual(main._load_settings()["vr_feed"]["repos"], [])


if __name__ == "__main__":
    unittest.main()
