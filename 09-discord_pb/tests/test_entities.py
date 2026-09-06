import importlib.util
import os
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("discord_pb_entities", ROOT / "backfill.py")
backfill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backfill)


GUILD = "20000000000000001"
CATEGORY = "20000000000000002"
CHANNEL = "10000000000000001"
CHANNEL_2 = "10000000000000002"
THREAD = "10000000000000003"
THREAD_2 = "10000000000000004"


class EntityShapeTests(unittest.TestCase):
    def test_channel_parent_is_guild_even_when_discord_reports_a_category_parent(self):
        row = backfill.entity({
            "id": CHANNEL,
            "type": 0,
            "name": "general",
            "guild_id": GUILD,
            "parent_id": CATEGORY,
        })

        self.assertEqual(row["parent_id"], GUILD)

    def test_thread_parent_remains_its_channel(self):
        row = backfill.entity({
            "id": THREAD,
            "type": 11,
            "name": "release-thread",
            "guild_id": GUILD,
            "parent_id": CHANNEL,
        })

        self.assertEqual(row["parent_id"], CHANNEL)

    def test_guild_parent_is_null(self):
        row = backfill.entity({
            "id": GUILD,
            "type": -1,
            "name": "Oracle Guild",
            "guild_id": GUILD,
            "parent_id": CATEGORY,
        }, "guild")

        self.assertIsNone(row["parent_id"])


class EntityUpsertTests(unittest.TestCase):
    def test_post_entities_splits_requests_at_500_records(self):
        items = [{"entity_id": str(index)} for index in range(501)]
        payload_sizes = []

        def post(_path, payload):
            payload_sizes.append(len(payload["entities"]))
            return {"ok": True, "received": len(payload["entities"])}

        with patch.object(backfill, "pb_post", side_effect=post):
            backfill.post_entities(items)

        self.assertEqual(payload_sizes, [500, 1])

    def test_post_entities_rejects_a_malformed_response_from_a_later_batch(self):
        items = [{"entity_id": str(index)} for index in range(501)]
        responses = [
            {"ok": True, "received": 500},
            {"ok": True, "received": 0},
        ]

        with patch.object(backfill, "pb_post", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "entity upsert failed"):
                backfill.post_entities(items)


class PaginatedNameResolutionTests(unittest.TestCase):
    def test_exact_match_on_a_later_page_wins_over_casefold_matches(self):
        calls = []

        def post(_path, payload):
            calls.append(dict(payload))
            if payload["kind"] == "thread":
                return {"matches": [], "has_more": False, "next_offset": None}
            if payload.get("offset", 0) == 0:
                return {
                    "matches": [{"entity_id": CHANNEL_2, "kind": "channel", "name": "General"}],
                    "has_more": True,
                    "next_offset": 100,
                }
            return {
                "matches": [{"entity_id": CHANNEL, "kind": "channel", "name": "general"}],
                "has_more": False,
                "next_offset": None,
            }

        with patch.object(backfill, "pb_post", side_effect=post):
            self.assertEqual(backfill.resolve_name("general", "channel"), CHANNEL)

        self.assertIn({"name": "general", "kind": "channel", "offset": 100}, calls)

    def test_casefold_ambiguity_includes_matches_from_later_pages(self):
        def post(_path, payload):
            if payload["kind"] == "thread":
                return {"matches": [], "has_more": False, "next_offset": None}
            if payload.get("offset", 0) == 0:
                return {
                    "matches": [{"entity_id": CHANNEL, "kind": "channel", "name": "General"}],
                    "has_more": True,
                    "next_offset": 1,
                }
            return {
                "matches": [{"entity_id": CHANNEL_2, "kind": "channel", "name": "GENERAL"}],
                "has_more": False,
                "next_offset": None,
            }

        with patch.object(backfill, "pb_post", side_effect=post):
            with self.assertRaisesRegex(ValueError, r"ambiguous.*General.*GENERAL"):
                backfill.resolve_name("general", "channel")

    def test_unicode_casefold_match_can_be_found_on_a_later_page(self):
        def post(_path, payload):
            if payload.get("offset", 0) == 0:
                return {
                    "matches": [{"entity_id": CHANNEL_2, "kind": "guild", "name": "Strasbourg"}],
                    "has_more": True,
                    "next_offset": 75,
                }
            return {
                "matches": [{"entity_id": GUILD, "kind": "guild", "name": "Straße"}],
                "has_more": False,
                "next_offset": None,
            }

        with patch.object(backfill, "pb_post", side_effect=post):
            self.assertEqual(backfill.resolve_name("STRASSE", "guild"), GUILD)

    def test_missing_name_is_reported_only_after_the_last_page(self):
        offsets = []

        def post(_path, payload):
            offsets.append(payload.get("offset", 0))
            if payload.get("offset", 0) == 0:
                return {"matches": [], "has_more": True, "next_offset": 40}
            return {"matches": [], "has_more": False, "next_offset": None}

        with patch.object(backfill, "pb_post", side_effect=post):
            with self.assertRaisesRegex(ValueError, r"not found.*candidates: none"):
                backfill.resolve_name("missing", "guild")

        self.assertEqual(offsets, [0, 40])


class ArchivedThreadPaginationTests(unittest.TestCase):
    def test_public_archive_encodes_its_timestamp_cursor(self):
        timestamp = "2026-09-06T01:02:03.456+00:00"
        pages = [
            {"threads": [{"id": THREAD, "thread_metadata": {"archive_timestamp": timestamp}}], "has_more": True},
            {"threads": [{"id": THREAD_2}], "has_more": False},
        ]

        with patch.object(backfill, "request_json", side_effect=pages) as requested:
            rows = backfill.list_archived(f"/channels/{CHANNEL}/threads/archived/public", {})

        self.assertEqual([row["id"] for row in rows], [THREAD, THREAD_2])
        self.assertIn("before=2026-09-06T01%3A02%3A03.456%2B00%3A00", requested.call_args_list[1].args[0])

    def test_joined_private_archive_uses_the_last_thread_id_as_cursor(self):
        pages = [
            {"threads": [{"id": THREAD}], "has_more": True},
            {"threads": [], "has_more": False},
        ]

        with patch.object(backfill, "request_json", side_effect=pages) as requested:
            backfill.list_archived(f"/channels/{CHANNEL}/users/@me/threads/archived/private", {}, joined=True)

        self.assertIn(f"before={THREAD}", requested.call_args_list[1].args[0])

    def test_archive_rejects_a_missing_cursor_when_more_pages_are_claimed(self):
        page = {"threads": [{"id": THREAD, "thread_metadata": {}}], "has_more": True}

        with patch.object(backfill, "request_json", return_value=page):
            with self.assertRaisesRegex(RuntimeError, "pagination did not advance"):
                backfill.list_archived(f"/channels/{CHANNEL}/threads/archived/public", {})

    def test_archive_rejects_a_repeated_cursor(self):
        timestamp = "2026-09-06T01:02:03+00:00"
        page = {"threads": [{"id": THREAD, "thread_metadata": {"archive_timestamp": timestamp}}], "has_more": True}

        with patch.object(backfill, "request_json", return_value=page):
            with self.assertRaisesRegex(RuntimeError, "pagination did not advance"):
                backfill.list_archived(f"/channels/{CHANNEL}/threads/archived/public", {})


class GuildDiscoveryTests(unittest.TestCase):
    def discovery_request(self, channels, active=None):
        def request(url, _headers):
            if url.endswith(f"/guilds/{GUILD}"):
                return {"id": GUILD, "name": "Oracle Guild"}
            if url.endswith(f"/guilds/{GUILD}/channels"):
                return channels
            if url.endswith(f"/guilds/{GUILD}/threads/active"):
                return {"threads": active or []}
            self.fail(f"unexpected Discord request: {url}")
        return request

    def test_discovery_scans_every_supported_archive_container(self):
        channels = [
            {"id": CHANNEL, "name": "text", "type": 0},
            {"id": CHANNEL_2, "name": "announcements", "type": 5},
            {"id": "10000000000000005", "name": "forum", "type": 15},
            {"id": "10000000000000006", "name": "media", "type": 16},
            {"id": "10000000000000007", "name": "voice", "type": 2},
        ]
        routes = []

        def archived(route, _headers, joined=False):
            routes.append((route, joined))
            return []

        with patch.object(backfill, "request_json", side_effect=self.discovery_request(channels)), \
             patch.object(backfill, "list_archived", side_effect=archived), \
             patch.object(backfill, "post_entities"):
            targets = backfill.discover_guild(GUILD, "token")

        public_routes = {route for route, joined in routes if route.endswith("/archived/public") and not joined}
        self.assertEqual(public_routes, {
            f"/channels/{CHANNEL}/threads/archived/public",
            f"/channels/{CHANNEL_2}/threads/archived/public",
            "/channels/10000000000000005/threads/archived/public",
            "/channels/10000000000000006/threads/archived/public",
        })
        self.assertEqual(targets, [CHANNEL, CHANNEL_2])

    def test_private_archive_403_falls_back_to_joined_private_archive(self):
        channels = [{"id": CHANNEL, "name": "text", "type": 0}]
        calls = []

        def archived(route, _headers, joined=False):
            calls.append((route, joined))
            if route.endswith("/threads/archived/private") and "/users/@me/" not in route:
                raise HTTPError(route, 403, "forbidden", {}, None)
            if "/users/@me/" in route:
                return [{"id": THREAD, "name": "private", "type": 12, "parent_id": CHANNEL}]
            return []

        with patch.object(backfill, "request_json", side_effect=self.discovery_request(channels)), \
             patch.object(backfill, "list_archived", side_effect=archived), \
             patch.object(backfill, "post_entities"):
            targets = backfill.discover_guild(GUILD, "token")

        self.assertIn((f"/channels/{CHANNEL}/users/@me/threads/archived/private", True), calls)
        self.assertIn(THREAD, targets)

    def test_repeated_discovery_rewalks_archives_and_adds_new_threads_without_duplicates(self):
        channels = [{"id": CHANNEL, "name": "text", "type": 0}]
        archive_calls = 0
        posted = []

        def archived(route, _headers, joined=False):
            nonlocal archive_calls
            if route.endswith("/archived/private"):
                return []
            archive_calls += 1
            first = {"id": THREAD, "name": "first", "type": 11, "parent_id": CHANNEL}
            second = {"id": THREAD_2, "name": "second", "type": 11, "parent_id": CHANNEL}
            return [first] if archive_calls == 1 else [first, second]

        with patch.object(backfill, "request_json", side_effect=self.discovery_request(channels, active=[
                 {"id": THREAD, "name": "first", "type": 11, "parent_id": CHANNEL},
             ])), patch.object(backfill, "list_archived", side_effect=archived), \
             patch.object(backfill, "post_entities", side_effect=lambda rows: posted.append(rows)):
            backfill.discover_guild(GUILD, "token")
            second_targets = backfill.discover_guild(GUILD, "token")

        second_ids = [row["entity_id"] for row in posted[1]]
        self.assertEqual(second_ids.count(THREAD), 1)
        self.assertIn(THREAD_2, second_ids)
        self.assertTrue(all(row["guild_id"] == GUILD for row in posted[1]))
        self.assertIn(THREAD_2, second_targets)


class MainResolutionOrderTests(unittest.TestCase):
    def setUp(self):
        self.selection = patch.object(backfill, "pb_post", side_effect=lambda _path, payload: {
            "initialized": "initial" in payload, "selected": payload.get("initial", []), "requests": []})
        self.selection.start()
        self.addCleanup(self.selection.stop)
        seed = patch.object(backfill, "seed_selection", side_effect=lambda ids, token: {
            "initialized": True, "selected": ids, "requests": []})
        seed.start(); self.addCleanup(seed.stop)

    def test_named_guild_bootstrap_paginates_all_available_guilds(self):
        first_page = [
            {"id": str(40000000000000000 + index), "name": f"Guild {index}"}
            for index in range(200)
        ]
        final_guild = {"id": "50000000000000001", "name": "Last Guild"}
        urls = []
        posted_sizes = []

        def request(url, _headers):
            urls.append(url)
            return [final_guild] if "after=" in url else first_page

        environment = {"DISCORD_BOT_TOKEN": "token", "DISCORD_GUILDS": "Last Guild"}
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, environment, clear=True), \
             patch.object(backfill, "STATE_FILE", str(Path(directory) / "state.json")), \
             patch.object(backfill, "request_json", side_effect=request), \
             patch.object(backfill, "post_entities", side_effect=lambda rows: posted_sizes.append(len(rows))), \
             patch.object(backfill, "resolve_name", return_value=final_guild["id"]), \
             patch.object(backfill, "discover_guild", return_value=[]), \
             patch.object(backfill, "state_lock", return_value=nullcontext()), \
             patch.object(backfill, "load_state", return_value={}):
            self.assertEqual(backfill.main(), 0)

        self.assertEqual(posted_sizes, [200, 1])
        self.assertIn("/users/@me/guilds?limit=200", urls[0])
        self.assertIn("after=40000000000000199", urls[1])

    def test_main_discovers_named_guild_before_resolving_named_channel(self):
        events = []

        def resolve(name, kind):
            events.append(f"resolve:{kind}:{name}")
            if kind == "guild":
                return GUILD
            self.assertIn(f"discover:{GUILD}", events)
            return CHANNEL

        def discover(guild_id, _token):
            events.append(f"discover:{guild_id}")
            return [CHANNEL_2]

        def fill(channel, _token, _high_water=None):
            return {"high_water": "0", "inserted": 0, "updated": 0}

        environment = {
            "DISCORD_BOT_TOKEN": "token",
            "DISCORD_CHANNELS": "general",
            "DISCORD_GUILDS": "Oracle Guild",
        }
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, environment, clear=True), \
             patch.object(backfill, "STATE_FILE", str(Path(directory) / "state.json")), \
             patch.object(backfill, "request_json", return_value=[{"id": GUILD, "name": "Oracle Guild"}]), \
             patch.object(backfill, "post_entities"), \
             patch.object(backfill, "resolve_name", side_effect=resolve), \
             patch.object(backfill, "discover_guild", side_effect=discover), \
             patch.object(backfill, "state_lock", return_value=nullcontext()), \
             patch.object(backfill, "load_state", return_value={}), \
             patch.object(backfill, "save_state"), \
             patch.object(backfill, "backfill", side_effect=fill):
            self.assertEqual(backfill.main(), 0)

        self.assertLess(events.index(f"discover:{GUILD}"), events.index("resolve:channel:general"))


if __name__ == "__main__":
    unittest.main()
