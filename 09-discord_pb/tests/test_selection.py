import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("selected_backfill", Path(__file__).parents[1] / "backfill.py")
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)
C, T, G = "10000000000000001", "10000000000000002", "20000000000000001"


class SelectedPollingTests(unittest.TestCase):
    def test_initial_seed_rejects_container_without_persisting_choices(self):
        for dtype in (2, 4, 13, 15, 16):
            with self.subTest(dtype=dtype), patch.object(backfill, "request_json", return_value={"id": C, "type": dtype}), \
                    patch.object(backfill, "post_entities"), patch.object(backfill, "pb_post") as persist:
                with self.assertRaisesRegex(ValueError, "initial channel.*not importable"):
                    backfill.seed_selection([C], "fixture-not-real")
                persist.assert_not_called()

    def run_poll(self, selection, *, requested=False, failure=False, initial=C):
        self.calls, self.fills = [], []
        def pb(path, body):
            self.calls.append((path, body))
            return selection if path.endswith("selection") else {"ok": True}
        def fill(channel, *_):
            self.fills.append(channel)
            if failure: raise RuntimeError("fixture failure")
            return {"high_water": "0", "inserted": 0, "updated": 0}
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {
            "DISCORD_BOT_TOKEN": "fixture-not-real", "DISCORD_CHANNELS": initial,
            "DISCORD_GUILDS": G, "DISCORD_PB_REQUESTED_ONLY": str(requested).lower(),
            "DC_CONFIG_PATH": str(Path(d) / "absent.yaml"),
        }, clear=True), patch.object(backfill, "STATE_FILE", str(Path(d) / "state.json")), \
             patch.object(backfill, "pb_post", side_effect=pb), \
             patch.object(backfill, "discover_guild", return_value=[C, T]) as discover, \
             patch.object(backfill, "backfill", side_effect=fill):
            result = backfill.main()
            self.discovered = discover.call_count
            return result

    def test_guild_lists_but_does_not_implicitly_import_anything(self):
        self.assertEqual(self.run_poll({"initialized": True, "selected": [], "requests": []}), 0)
        self.assertEqual(self.fills, [])
        self.assertEqual(self.discovered, 1)

    def test_option_does_not_reenable_previously_deselected_channel(self):
        self.run_poll({"initialized": True, "selected": [T], "requests": []})
        self.assertEqual(self.fills, [T])
        self.assertFalse(any("initial" in payload for _, payload in self.calls))

    def test_declared_model_wins_even_before_option_selection_seed(self):
        self.run_poll({"initialized": False, "model_present": True, "selected": [T], "requests": []}, initial="removed-name")
        self.assertEqual(self.fills, [T])
        self.assertFalse(any("initial" in payload for _, payload in self.calls))

    def test_explicit_import_is_channel_only_and_acks_the_observed_request(self):
        self.run_poll({"initialized": True, "selected": [C], "requests": [{"entity_id": T, "request_id": "r1"}]}, requested=True)
        self.assertEqual(self.fills, [T])
        self.assertEqual(self.discovered, 0)
        self.assertIn(("/api/discord/internal/import-ack", {"entity_id": T, "request_id": "r1"}), self.calls)

    def test_failed_import_keeps_request_for_retry(self):
        result = self.run_poll({"initialized": True, "selected": [], "requests": [{"entity_id": T, "request_id": "r1"}]}, requested=True, failure=True)
        self.assertEqual(result, 1)
        self.assertFalse(any(path.endswith("import-ack") for path, _ in self.calls))
