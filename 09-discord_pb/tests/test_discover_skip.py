"""Guild discovery must survive channels the bot cannot read (403) or that vanished (404)."""
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backfill  # noqa: E402

GUILD = "20000000000000001"
VISIBLE = "20000000000000002"
HIDDEN = "20000000000000003"
GONE = "20000000000000004"


def http_error(code):
    return HTTPError("https://discord.com/api/v10/x", code, "err", {}, io.BytesIO(b"{}"))


class DiscoverSkipTests(unittest.TestCase):
    def run_discovery(self):
        def request_json(url, headers):
            if url.endswith(f"/guilds/{GUILD}"):
                return {"id": GUILD, "name": "Guild"}
            if url.endswith("/channels"):
                return [{"id": VISIBLE, "type": 0, "name": "open", "position": 0},
                        {"id": HIDDEN, "type": 0, "name": "staff", "position": 1},
                        {"id": GONE, "type": 5, "name": "old-news", "position": 2}]
            if url.endswith("/threads/active"):
                return {"threads": []}
            raise AssertionError("unexpected request " + url)

        def list_archived(route, headers, joined):
            if f"/channels/{HIDDEN}/" in route:
                raise http_error(403)
            if f"/channels/{GONE}/" in route:
                raise http_error(404)
            return [{"id": "20000000000000009", "type": 11, "name": "t", "parent_id": VISIBLE, "thread_metadata": {}}]

        posted = []
        skipped = []
        with patch.object(backfill, "request_json", side_effect=request_json), \
             patch.object(backfill, "list_archived", side_effect=list_archived), \
             patch.object(backfill, "post_entities", side_effect=lambda items: posted.extend(items)), \
             patch("sys.stderr", io.StringIO()):
            targets = backfill.discover_guild(GUILD, "token", skipped)
        return targets, posted, skipped

    def test_unreadable_channels_are_indexed_but_their_archives_skipped(self):
        targets, posted, skipped = self.run_discovery()
        self.assertEqual(set(targets), {VISIBLE, HIDDEN, GONE, "20000000000000009"})
        self.assertEqual(sorted(row["entity_id"] for row in posted), sorted([GUILD, VISIBLE, HIDDEN, GONE, "20000000000000009"]))
        self.assertEqual([(row["channel_id"], row["status"]) for row in skipped],
                         [(HIDDEN, 403), (HIDDEN, 403), (GONE, 404)])

    def test_other_http_errors_still_raise(self):
        def list_archived(route, headers, joined):
            raise http_error(500)
        with patch.object(backfill, "request_json", side_effect=lambda url, headers: {"id": GUILD} if url.endswith(GUILD) else [{"id": VISIBLE, "type": 0, "name": "open"}] if url.endswith("/channels") else {"threads": []}), \
             patch.object(backfill, "list_archived", side_effect=list_archived), \
             patch.object(backfill, "post_entities"):
            with self.assertRaises(HTTPError):
                backfill.discover_guild(GUILD, "token", [])

    def test_main_reports_a_failed_guild_and_keeps_going(self):
        events = []
        def discover(guild_id, token):
            events.append(guild_id)
            if guild_id == GUILD:
                raise RuntimeError("bot was kicked")
        summary = {}
        def capture(text):
            summary["text"] = text
        with patch.dict("os.environ", {"DISCORD_BOT_TOKEN": "t", "DISCORD_GUILDS": f"{GUILD},{VISIBLE}", "DISCORD_CHANNELS": ""}), \
             patch.object(backfill, "discover_guild", side_effect=discover), \
             patch.object(backfill, "pb_post", return_value={"initialized": True, "model_present": False, "selected": [], "requests": []}), \
             patch.object(backfill, "discovery_guilds", return_value=[], create=True), \
             patch("dc_model.discovery_guilds", return_value=[]), \
             patch("sys.stderr", io.StringIO()), patch("sys.stdout", io.StringIO()) as out:
            code = backfill.main()
        self.assertEqual(events, [GUILD, VISIBLE], "the second guild still ran")
        self.assertEqual(code, 1)
        self.assertIn('"guild_id": "20000000000000001"', out.getvalue())
        self.assertIn('"skipped_archives": []', out.getvalue())


if __name__ == "__main__":
    unittest.main()
