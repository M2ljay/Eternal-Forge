"""GameBanana as a second mod source: parsing, the client's retries and
caching, update detection, and the hooks that let GameBanana mods use the
Nexus install pipeline. Answers are synthetic, shaped like apiv11 and the
Core API; nothing here touches the network."""
import asyncio
import hashlib
import json
import os
import time
import unittest
from unittest import mock

from test_backend import main

import gamebanana as gb

NOW = 1_763_000_000


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


async def _no_sleep(_s):
    return None


def gb_file(fid, name, date, md5="", size=2048, version=""):
    return {"_idRow": fid, "_sFile": name, "_nFilesize": size, "_tsDateAdded": date,
            "_nDownloadCount": 10, "_sDownloadUrl": f"https://gamebanana.com/dl/{fid}",
            "_sMd5Checksum": md5, "_sAnalysisResult": "ok", "_bContainsExe": False,
            "_sDescription": "", "_sVersion": version}


def index_record(mid, name, nsfw=False):
    return {"_idRow": mid, "_sModelName": "Mod", "_sName": name,
            "_aSubmitter": {"_idRow": 5, "_sName": "Author"},
            "_aPreviewMedia": {"_aImages": [{"_sBaseUrl": "https://images.gamebanana.com/img/ss/mods",
                                             "_sFile": f"{mid}.jpg", "_sFile220": f"220-90_{mid}.jpg",
                                             "_sFile530": f"530-90_{mid}.jpg"}]},
            "_nLikeCount": 7, "_nViewCount": 300, "_tsDateAdded": NOW - 1000, "_tsDateUpdated": NOW,
            "_aRootCategory": {"_sName": "Skins"}, "_bIsNsfw": nsfw, "_bHasFiles": True}


def profile(mid, files, text="<p>Hello</p>"):
    rec = index_record(mid, f"Mod {mid}")
    rec.update({"_sText": text, "_aFiles": files, "_aGame": {"_idRow": 6460, "_sName": "Some Game"},
                "_aCategory": {"_sName": "Skins"}, "_nDownloadCount": 99, "_sDescription": "short"})
    return rec


class FakeNet:
    """A transport answering from a {substring: (status, body)} table, in
    order; records every URL asked for."""

    def __init__(self, routes):
        self.routes = routes
        self.urls = []

    async def __call__(self, url):
        self.urls.append(url)
        for needle, answer in self.routes:
            if needle in url:
                if isinstance(answer, list):
                    answer = answer.pop(0) if len(answer) > 1 else answer[0]
                status, body = answer
                return status, body if isinstance(body, str) else json.dumps(body)
        return 404, "{}"


def client(routes):
    net = FakeNet(routes)
    return gb.Client(net, sleep=_no_sleep), net


class IdsAndText(unittest.TestCase):
    def test_ids(self):
        self.assertTrue(gb.is_gb_id(gb.to_local(123)))
        self.assertFalse(gb.is_gb_id(123456))
        self.assertFalse(gb.is_gb_id(None))
        self.assertEqual(gb.from_local(gb.to_local(48151)), 48151)

    def test_download_url_only_gamebanana(self):
        self.assertEqual(gb.download_url(5, "https://gamebanana.com/dl/5"), "https://gamebanana.com/dl/5")
        self.assertEqual(gb.download_url(5, "http://files.gamebanana.com/mods/x.zip"),
                         "https://files.gamebanana.com/mods/x.zip")
        self.assertEqual(gb.download_url(5, "https://evil.example/x.zip"), "https://gamebanana.com/dl/5")
        self.assertEqual(gb.download_url(5, "https://gamebanana.com.evil.example/x"), "https://gamebanana.com/dl/5")

    def test_html_to_text(self):
        text, images = gb.html_to_text(
            "<h2>Install</h2><p>Drop it in <b>mods</b>&amp;go.</p><ul><li>One</li><li>Two</li></ul>"
            "<script>alert(1)</script><iframe src='x'>bad</iframe>"
            "<img src='https://images.gamebanana.com/img/a.png'><img src='https://tracker.example/p.gif'>")
        self.assertIn("Drop it in mods&go.", text)
        self.assertIn("• One", text)
        self.assertNotIn("alert", text)
        self.assertNotIn("bad", text)
        self.assertNotIn("<", text)
        self.assertEqual(images, ["https://images.gamebanana.com/img/a.png"])

    def test_game_ref(self):
        self.assertEqual(gb.parse_game_ref("6460"), 6460)
        self.assertEqual(gb.parse_game_ref("https://gamebanana.com/games/6460"), 6460)
        self.assertEqual(gb.parse_game_ref("https://gamebanana.com/mods/games/6460?x"), 6460)
        self.assertEqual(gb.parse_game_ref("sonic"), 0)

    def test_best_game_match(self):
        cands = [{"id": 1, "name": "Sonic Frontiers Prologue"}, {"id": 2, "name": "Sonic Frontiers"}]
        self.assertEqual(gb.best_game_match("SONIC FRONTIERS", cands)["id"], 2)
        self.assertIsNone(gb.best_game_match("Sonic", cands))

    def test_profile_shape(self):
        p = gb.mod_profile(profile(77, [gb_file(1, "a_v1.zip", NOW - 50), gb_file(2, "a_v2.zip", NOW)]))
        self.assertEqual(p["mod_id"], gb.to_local(77))
        self.assertEqual([f["gb_file_id"] for f in p["files"]], [2, 1])
        self.assertEqual(p["files"][0]["file_id"], gb.to_local(2))
        self.assertEqual(p["files"][0]["size_kb"], 2)
        self.assertTrue(p["thumbnail"].endswith("530-90_77.jpg"))
        self.assertEqual(p["text"], "Hello")
        self.assertEqual(p["game_id"], 6460)
        with self.assertRaises(gb.GBError):
            gb.mod_profile({})

    def test_core_files_shapes(self):
        f = gb_file(9, "x.zip", NOW)
        self.assertEqual(len(gb.core_files([{"9": f}])), 1)
        self.assertEqual(len(gb.core_files({"Files().aFiles()": {"9": f}})), 1)
        self.assertEqual(len(gb.core_files([[f]])), 1)
        self.assertEqual(gb.core_files(["no files", 3]), [])


class ClientTests(unittest.TestCase):
    def test_retries_busy_then_reads(self):
        c, net = client([("ProfilePage", [(503, "busy"), (200, profile(5, []))])])
        self.assertEqual(run(c.mod(5))["gb_id"], 5)
        self.assertEqual(len(net.urls), 2)

    def test_web_page_instead_of_data(self):
        c, _ = client([("ProfilePage", (200, "<!DOCTYPE html><html>Just a moment...</html>"))])
        with self.assertRaises(gb.GBError) as e:
            run(c.mod(5))
        self.assertIn("web page", str(e.exception))

    def test_not_found_and_error_body(self):
        c, _ = client([("ProfilePage", (404, "{}"))])
        with self.assertRaises(gb.GBError):
            run(c.mod(5))
        c, _ = client([("ProfilePage", (200, {"_sErrorCode": "INVALID", "_sErrorMessage": "Bad id"}))])
        with self.assertRaisesRegex(gb.GBError, "Bad id"):
            run(c.mod(5))

    def test_transport_exception_becomes_message(self):
        async def boom(url):
            raise ConnectionError("down")
        c = gb.Client(boom, sleep=_no_sleep)
        with self.assertRaisesRegex(gb.GBError, "Network error"):
            run(c.mod(5))

    def test_list_paging_sort_and_cache(self):
        page = {"_aMetadata": {"_nRecordCount": 30, "_bIsComplete": False},
                "_aRecords": [index_record(1, "A"), index_record(2, "B", nsfw=True)]}
        c, net = client([("_sSort=Generic_MostLiked", (400, "{}")), ("Mod/Index", (200, page))])
        got = run(c.list_mods(6460, 1, "liked"))
        self.assertTrue(got["sort_fallback"])
        self.assertEqual([m["name"] for m in got["mods"]], ["A", "B"])
        self.assertTrue(got["has_more"])
        self.assertIn("_aFilters%5BGeneric_Game%5D=6460", net.urls[-1])
        n = len(net.urls)
        run(c.list_mods(6460, 1, "liked"))
        self.assertEqual(len(net.urls), n, "second read comes from the cache")

    def test_search_uses_search_endpoint(self):
        c, net = client([("Util/Search/Results", (200, {"_aMetadata": {"_nRecordCount": 1, "_bIsComplete": True},
                                                        "_aRecords": [index_record(3, "Cool skin")]}))])
        got = run(c.list_mods(6460, 1, "default", "cool skin"))
        self.assertEqual(got["mods"][0]["gb_id"], 3)
        self.assertFalse(got["has_more"])
        self.assertIn("_sSearchString=cool%20skin", net.urls[0])
        self.assertIn("_idGameRow=6460", net.urls[0])

    def test_files_for_core_then_profile_fallback(self):
        core = [{"11": gb_file(11, "a.zip", NOW)}, []]
        c, net = client([("Core/Item/Data", (200, core)),
                         ("Mod/2/ProfilePage", (200, profile(2, [gb_file(21, "b.zip", NOW)])))])
        got = run(c.files_for([1, 2]))
        self.assertEqual(got[1][0]["gb_file_id"], 11)
        self.assertEqual(got[2][0]["gb_file_id"], 21)
        self.assertIn("itemid[]=1", net.urls[0])
        self.assertEqual(run(c.file_download(11))["url"], "https://gamebanana.com/dl/11")
        self.assertEqual(run(c.file_download(999))["md5"], "")

    def test_match_games(self):
        c, _ = client([("NameMatch", (200, {"_aRecords": [{"_idRow": 6460, "_sName": "Celeste"}]}))])
        self.assertEqual(run(c.match_games("Celeste")), [{"id": 6460, "name": "Celeste", "icon": ""}])
        self.assertEqual(run(c.match_games("C")), [])


class UpdateRules(unittest.TestCase):
    def rec(self, gb_file_id, name, **kw):
        return dict({"mod_id": gb.to_local(1), "file_id": gb.to_local(gb_file_id), "file_name": name,
                     "installed_at": NOW}, **kw)

    def test_newer_upload_of_same_file(self):
        files = gb.files_newest_first([gb_file(1, "skin_v1.zip", NOW - 9000), gb_file(2, "skin_v2.zip", NOW)])
        u = gb.update_for(self.rec(1, "skin_v1.zip"), files)
        self.assertTrue(u["update_available"])
        self.assertEqual(u["file"]["gb_file_id"], 2)

    def test_old_file_deleted(self):
        files = gb.files_newest_first([gb_file(2, "something_else.7z", NOW + 5000)])
        u = gb.update_for(self.rec(1, "skin_v1.zip", gb_file_date=NOW - 9000), files)
        self.assertTrue(u["update_available"])

    def test_variant_uploaded_together_is_not_an_update(self):
        files = gb.files_newest_first([gb_file(1, "red.zip", NOW), gb_file(2, "blue.zip", NOW + 30)])
        self.assertFalse(gb.update_for(self.rec(1, "red.zip"), files)["update_available"])

    def test_newer_other_variant_while_mine_is_up(self):
        files = gb.files_newest_first([gb_file(1, "red.zip", NOW), gb_file(2, "blue.zip", NOW + 90000)])
        self.assertFalse(gb.update_for(self.rec(1, "red.zip"), files)["update_available"])

    def test_up_to_date(self):
        files = gb.files_newest_first([gb_file(1, "skin.zip", NOW, version="1.4")])
        u = gb.update_for(self.rec(1, "skin.zip"), files)
        self.assertFalse(u["update_available"])
        self.assertEqual(u["current"], "1.4")


class PluginHooks(unittest.TestCase):
    def setUp(self):
        main._save_settings({})
        self.plugin = main.Plugin()

    def tearDown(self):
        main._GB_CLIENT = None

    def use(self, routes):
        c, net = client(routes)
        main._GB_CLIENT = c
        return net

    def test_auto_link_by_exact_name(self):
        self.use([("NameMatch", (200, {"_aRecords": [{"_idRow": 6460, "_sName": "Celeste"},
                                                     {"_idRow": 9, "_sName": "Celeste Classic"}]}))])
        r = run(self.plugin.gb_get_game(504230, "Celeste"))
        self.assertEqual(r["linked"]["id"], 6460)
        self.assertEqual(main._load_settings()["gamebanana"]["games"]["504230"]["id"], 6460)

    def test_ambiguous_offers_candidates_then_manual_link(self):
        self.use([("NameMatch", (200, {"_aRecords": [{"_idRow": 1, "_sName": "Sonic Mania Plus"}]})),
                  ("Core/Item/Data", (200, {"name": "Sonic Mania"}))])
        r = run(self.plugin.gb_get_game(584400, "Sonic Mania"))
        self.assertIsNone(r["linked"])
        self.assertEqual(r["candidates"][0]["id"], 1)
        self.assertFalse(run(self.plugin.gb_link_game(584400, "not a link"))["ok"])
        r = run(self.plugin.gb_link_game(584400, "https://gamebanana.com/games/6110"))
        self.assertEqual(r["linked"], {"id": 6110, "name": "Sonic Mania", "auto": False})
        run(self.plugin.gb_unlink_game(584400))
        self.assertNotIn("584400", main._load_settings()["gamebanana"]["games"])

    def test_list_marks_installed_and_hides_adult(self):
        settings = {"gamebanana": {"games": {"1": {"id": 6460, "name": "G", "auto": True}}},
                    "installed": {"dom": {"A": {"mod_id": gb.to_local(1), "file_id": gb.to_local(5)}}}}
        main._save_settings(settings)
        self.use([("Mod/Index", (200, {"_aMetadata": {"_nRecordCount": 2, "_bIsComplete": True},
                                       "_aRecords": [index_record(1, "A"), index_record(2, "B", nsfw=True)]}))])
        with mock.patch.object(main, "_show_adult", return_value=False):
            r = run(self.plugin.gb_list_mods("dom", 1, 1, "default", ""))
        self.assertEqual([(m["name"], m["installed"]) for m in r["mods"]], [("A", True)])
        self.assertEqual(r["hidden"], 1)
        self.assertFalse(run(self.plugin.gb_list_mods("dom", 2, 1, "default", ""))["ok"])

    def test_files_and_thumbnails_answer_for_gamebanana_ids(self):
        self.use([("Mod/4/ProfilePage", (200, profile(4, [gb_file(40, "a.zip", NOW - 99), gb_file(41, "b.zip", NOW)])))])
        r = run(self.plugin.get_mod_files("dom", gb.to_local(4)))
        self.assertEqual([f["file_id"] for f in r["files"]], [gb.to_local(41), gb.to_local(40)])
        self.assertTrue(r["files"][0]["is_primary"])
        r = run(self.plugin.get_mods_by_ids("dom", [gb.to_local(4)]))
        self.assertEqual(r["mods"][0]["modId"], gb.to_local(4))
        self.assertTrue(r["mods"][0]["thumbnailUrl"].startswith("https://images.gamebanana.com/"))
        self.assertTrue(run(self.plugin.get_mod_details("dom", gb.to_local(4)))["gamebanana"])
        self.assertEqual(run(self.plugin.match_file_to_game("dom", gb.to_local(4), "x", "y.exe"))["file_id"], 0)

    def test_check_updates_merges_gamebanana_without_nexus(self):
        main._save_settings({"installed": {"dom": {
            "Skin": {"mod_id": gb.to_local(1), "file_id": gb.to_local(10), "file_name": "skin_v1.zip",
                     "version": "1.0", "installed_at": NOW, "gb_file_date": NOW - 100}}}})
        self.use([("Core/Item/Data", (200, [{"11": gb_file(11, "skin_v2.zip", NOW + 9000, version="2.0")}]))])
        with mock.patch.object(main, "_gql_query", side_effect=AssertionError("asked Nexus")):
            r = run(self.plugin.check_updates("dom"))
        self.assertTrue(r["ok"])
        self.assertTrue(r["updates"]["Skin"]["update_available"])
        self.assertEqual(r["updates"]["Skin"]["current"], "2.0")
        t = run(self.plugin.gb_update_target("dom", gb.to_local(1), "Skin"))
        self.assertEqual(t["file"]["file_id"], gb.to_local(11))

    def test_nexus_batches_skip_gamebanana_ids(self):
        seen = []

        async def fake(query, api_key=None):
            seen.append(query)
            return {"legacyMods": {"nodes": []}}
        with mock.patch.object(main, "_gql_query", fake):
            run(main._legacy_mods_in_batches(1, [gb.to_local(3)], "modId", None))
            run(main._legacy_mods_in_batches(1, [3, gb.to_local(3)], "modId", None))
        self.assertEqual(len(seen), 1)
        self.assertNotIn(str(gb.to_local(3)), seen[0])

    def test_install_needs_no_nexus_key_and_tags_record(self):
        main._save_settings({})
        gb_mod, gb_fid = gb.to_local(8), gb.to_local(80)
        self.use([("Mod/8/ProfilePage", (200, profile(8, [gb_file(80, "x.zip", NOW)])))])
        run(main._gb_client().mod(8))

        async def inner(self_, game_domain, mod_id, file_id, *a, **k):
            s = main._load_settings()
            s.setdefault("installed", {}).setdefault(game_domain, {})["X"] = {
                "mod_id": mod_id, "file_id": file_id, "name": "X", "source": "gamebanana"}
            main._save_settings(s)
            return {"ok": True, "folder": "X"}
        with mock.patch.object(main.Plugin, "_install_mod_inner", inner):
            r = run(self.plugin.install_mod("dom", gb_mod, gb_fid, "x.zip", "X", "", "/nowhere", "mods"))
        self.assertTrue(r["ok"])
        rec = main._load_settings()["installed"]["dom"]["X"]
        self.assertEqual((rec["gb_mod_id"], rec["gb_file_id"], rec["gb_file_date"]), (8, 80, NOW))

    def test_inner_install_without_key_is_not_refused_for_gamebanana(self):
        main._save_settings({})
        r = run(self.plugin._install_mod_inner("dom", gb.to_local(1), gb.to_local(2), "x.zip", "X", "",
                                               "/definitely/not/here", "mods"))
        self.assertEqual(r["error"], "Game install folder not found")
        r = run(self.plugin._install_mod_inner("dom", 1, 2, "x.zip", "X", "", "/definitely/not/here", "mods"))
        self.assertEqual(r["error"], "Not signed in")

    def test_download_check(self):
        d = os.path.join(main.DOWNLOADS_DIR, "gbcheck")
        os.makedirs(d, exist_ok=True)
        page = os.path.join(d, "page.zip")
        with open(page, "wb") as f:
            f.write(b"<!DOCTYPE html><html><head><title>x</title>")
        self.assertIn("web page", main._gb_verify(page, ""))
        good = os.path.join(d, "good.zip")
        with open(good, "wb") as f:
            f.write(b"PK\x03\x04data")
        self.assertEqual(main._gb_verify(good, hashlib.md5(b"PK\x03\x04data").hexdigest()), "")
        self.assertIn("checksum", main._gb_verify(good, "0" * 32))


if __name__ == "__main__":
    unittest.main()
