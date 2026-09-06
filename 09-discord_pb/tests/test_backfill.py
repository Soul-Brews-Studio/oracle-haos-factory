import importlib.util, io, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

path = Path(__file__).parents[1] / "backfill.py"
spec = importlib.util.spec_from_file_location("discord_pb_backfill", path)
backfill = importlib.util.module_from_spec(spec); spec.loader.exec_module(backfill)

C = "10000000000000001"; C2 = "10000000000000002"; T = "10000000000000003"
G = "20000000000000001"; A = "30000000000000001"; BASE = 11000000000000000

def message(mid, **values):
    item = {"id": str(mid), "author": {"id": A, "username": "user"},
            "content": f"m{mid}", "attachments": [], "embeds": [],
            "type": 0, "mentions": [], "mention_roles": [], "flags": 0,
            "components": [], "pinned": False, "mention_everyone": False, "tts": False,
            "timestamp": "2026-09-06T00:00:00.000000+00:00", "edited_timestamp": None}
    item.update(values); return item

def response(payload):
    stream = io.BytesIO(json.dumps(payload).encode())
    stream.__enter__ = lambda value: value; stream.__exit__ = lambda *args: None
    return stream

class FakeError(HTTPError):
    def __init__(self, code, headers=None, body=b""):
        super().__init__("http://fixture", code, "error", headers or {}, io.BytesIO(body))

class DiscordFixture:
    """Discord selection semantics with deliberately unsorted response arrays."""
    def __init__(self, by_channel, fail_channel=None):
        self.by_channel = by_channel; self.fail_channel = fail_channel; self.urls = []
    def __call__(self, url, headers):
        self.urls.append(url); parsed = urlparse(url); parts = parsed.path.split("/")
        channel = parts[-1] if parts[-1] != "messages" else parts[-2]
        if channel == self.fail_channel: raise HTTPError(url, 403, "forbidden", {}, None)
        if parts[-1] != "messages": return {"id": channel, "type": 0, "guild_id": G}
        ids = self.by_channel.get(channel, []); query = parse_qs(parsed.query)
        if "before" in query:
            ids = [mid for mid in ids if mid < int(query["before"][0])]
            selected = sorted(ids, reverse=True)[:100]
        elif "after" in query:
            ids = [mid for mid in ids if mid > int(query["after"][0])]
            selected = sorted(ids)[:100]
        else:
            selected = sorted(ids, reverse=True)[:100]
        if len(selected) > 2: selected[0], selected[-1] = selected[-1], selected[0]
        return [message(mid) for mid in selected]

def successful_post(items):
    return {"ok": True, "received": len(items), "inserted": len(items), "updated": 0}

class BackfillTests(unittest.TestCase):
    def run_main(self, state_path, fixture, channels=C, post=successful_post):
        env = {"DISCORD_BOT_TOKEN": "token", "DISCORD_CHANNELS": channels}
        with patch.dict(os.environ, env, clear=True), patch.object(backfill, "STATE_FILE", state_path), \
             patch.object(backfill, "request_json", side_effect=fixture), patch.object(backfill, "post_batch", side_effect=post):
            return backfill.main()

    def test_205_historical_then_new_process_incremental_imports_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json")
            fixture = DiscordFixture({C: list(range(BASE + 1, BASE + 206))})
            output = io.StringIO()
            with patch("sys.stdout", output): self.assertEqual(self.run_main(state_path, fixture), 0)
            self.assertEqual(backfill.load_state(state_path), {C: str(BASE + 205)})
            script = "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['load_state'](sys.argv[2]),sort_keys=True))"
            fresh = subprocess.run([sys.executable, "-c", script, str(path), state_path], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(fresh.stdout), {C: str(BASE + 205)})
            first_urls = list(fixture.urls); fixture.urls.clear()
            with patch("sys.stdout", output): self.assertEqual(self.run_main(state_path, fixture), 0)
            message_urls = [url for url in fixture.urls if "/messages?" in url]
            self.assertEqual(len(message_urls), 1)
            self.assertIn(f"after={BASE + 205}", message_urls[0]); self.assertNotIn("before=", message_urls[0])
            logs = output.getvalue()
            self.assertIn('"mode": "historical"', logs); self.assertIn('"before": "latest"', logs)
            self.assertIn('"mode": "incremental"', logs); self.assertIn(f'"after": "{BASE + 205}"', logs)
            self.assertEqual(sum("/messages?" in url for url in first_urls), 4)

    def test_incremental_more_than_100_has_no_gap_despite_unsorted_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json"); backfill.save_state({C: str(BASE)}, state_path)
            fixture = DiscordFixture({C: list(range(BASE + 1, BASE + 206))}); batches = []
            def post(items): batches.extend(int(item["message_id"]) for item in items); return successful_post(items)
            self.assertEqual(self.run_main(state_path, fixture, post=post), 0)
            self.assertEqual(len(batches), 205); self.assertEqual(set(batches), set(range(BASE + 1, BASE + 206)))
            self.assertEqual(backfill.load_state(state_path)[C], str(BASE + 205))
            afters = [parse_qs(urlparse(url).query)["after"][0] for url in fixture.urls if "/messages?" in url]
            self.assertEqual(afters, [str(BASE), str(BASE + 100), str(BASE + 200), str(BASE + 205)])

    def test_empty_historical_commits_zero_then_uses_after_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json"); fixture = DiscordFixture({C: []})
            self.assertEqual(self.run_main(state_path, fixture), 0); self.assertEqual(backfill.load_state(state_path), {C: "0"})
            fixture.urls.clear(); self.assertEqual(self.run_main(state_path, fixture), 0)
            self.assertIn("after=0", [url for url in fixture.urls if "/messages?" in url][0])

    def test_mid_sweep_failure_never_advances_initial_or_incremental_mark(self):
        for initial in (None, str(BASE)):
            with self.subTest(initial=initial), tempfile.TemporaryDirectory() as directory:
                state_path = os.path.join(directory, "state.json")
                if initial is not None: backfill.save_state({C: initial}, state_path)
                fixture = DiscordFixture({C: list(range(BASE + 1, BASE + 206))}); calls = 0
                def fail_second(items):
                    nonlocal calls; calls += 1
                    if calls == 2: raise RuntimeError("mid-sweep")
                    return successful_post(items)
                self.assertEqual(self.run_main(state_path, fixture, post=fail_second), 1)
                self.assertEqual(backfill.load_state(state_path).get(C), initial)

    def test_channel_failure_continues_and_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json")
            fixture = DiscordFixture({C2: [BASE + 1]}, fail_channel=C)
            self.assertEqual(self.run_main(state_path, fixture, channels=f"{C},{C2}"), 1)
            self.assertEqual(backfill.load_state(state_path), {C2: str(BASE + 1)})

    def test_corrupt_state_fails_closed_before_api_call(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json"); Path(state_path).write_text("not json")
            fixture = DiscordFixture({C: [BASE + 1]})
            self.assertEqual(self.run_main(state_path, fixture), 1); self.assertEqual(fixture.urls, [])
            self.assertEqual(Path(state_path).read_text(), "not json")

    def test_atomic_state_replace_and_lock_rejects_concurrency(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "state.json")
            with patch.object(backfill.os, "replace", wraps=os.replace) as replace:
                backfill.save_state({C: str(BASE)}, state_path)
            replace.assert_called_once(); self.assertEqual(backfill.load_state(state_path), {C: str(BASE)})
            self.assertEqual([name for name in os.listdir(directory) if name.startswith(".backfill-state.")], [])
            with patch.object(backfill.os, "replace", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"): backfill.save_state({C: str(BASE + 1)}, state_path)
            self.assertEqual(backfill.load_state(state_path), {C: str(BASE)})
            self.assertEqual([name for name in os.listdir(directory) if name.startswith(".backfill-state.")], [])
            with backfill.state_lock(state_path):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    with backfill.state_lock(state_path): pass

    def test_normalize_uses_only_channel_context_for_routing(self):
        context = backfill.channel_context({"id": T, "type": 11, "parent_id": C, "guild_id": G})
        payload = backfill.normalize(message(BASE, channel_id="99999999999999999", guild_id="88888888888888888",
                                             thread_id="77777777777777777", parent_id="66666666666666666"), context)
        self.assertEqual((payload["channel_id"], payload["thread_id"], payload["guild_id"]), (C, T, G))
        self.assertTrue({"created_at", "routed_to", "routed_at"}.isdisjoint(payload))

    def test_429_403_5xx_and_post_contract(self):
        error = FakeError(429, {"Retry-After": "2"}, b'{"retry_after":4.5}')
        with patch.object(backfill, "urlopen", side_effect=[error, response({"ok": True})]), \
             patch.object(backfill.random, "random", return_value=0), patch.object(backfill.time, "sleep") as sleep:
            self.assertEqual(backfill.request_json("http://x", {}), {"ok": True}); sleep.assert_called_once_with(4.5)
        with patch.object(backfill, "urlopen", side_effect=FakeError(403)) as opened:
            with self.assertRaises(HTTPError): backfill.request_json("http://x", {})
        self.assertEqual(opened.call_count, 1)
        with patch.object(backfill, "urlopen", side_effect=[FakeError(503)] * 3), patch.object(backfill.random, "random", return_value=0), patch.object(backfill.time, "sleep"):
            with self.assertRaises(HTTPError): backfill.request_json("http://x", {}, retries=2)
        invalid = {"ok": True, "received": 1, "inserted": 1, "updated": 0}
        with patch.dict(os.environ, {"DISCORD_PB_INTERNAL_TOKEN": "internal"}), patch.object(backfill, "urlopen", return_value=response(invalid)):
            with self.assertRaises(RuntimeError): backfill.post_batch([{}, {}])

    def test_fixture_token_and_snowflake_guards(self):
        with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true", "DISCORD_BOT_TOKEN": "secret"}, clear=True):
            with self.assertRaises(RuntimeError): backfill.main()
            with self.assertRaises(RuntimeError): backfill.discord_headers("secret")
        for invalid in ("123", "1" * 21, "１２３４５６７８９０１２３４５６７"):
            with self.assertRaises(ValueError): backfill.snowflake(invalid, "test")

if __name__ == "__main__": unittest.main()
