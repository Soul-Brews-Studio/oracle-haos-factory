import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).parents[1]
import sys
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
import gateway
import gateway_ws
from fake_gateway import FakeGateway, hello, receive_until, send_frame, send_json


READY = {"op": 0, "s": 1, "t": "READY", "d": {"session_id": "session-one", "resume_gateway_url": ""}}
MESSAGE = {"id": "1485581352354054215", "channel_id": "1485581352354054216"}


class GatewayTests(unittest.TestCase):
    def test_options_live_defaults_true_and_rejects_non_boolean(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "options.json"
            path.write_text("{}")
            self.assertTrue(gateway.load_options(path).get("live", True))
            path.write_text('{"live":"true"}')
            with self.assertRaises(ValueError): gateway.load_options(path)

    def test_gateway_bot_fixture_is_private_and_identify_has_exact_intents(self):
        def script(fixture, stream):
            hello(stream)
            identify = receive_until(stream, 2, fixture)
            self.assertEqual(identify["d"]["intents"], 33281)
            send_json(stream, READY)
            send_frame(stream, 8, struct.pack("!H", 4000))

        server = FakeGateway([script]).start()
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                url = gateway.gateway_api("", server.api_url)
            self.assertTrue(url.startswith(server.ws_url + "?"))
            self.assertEqual(url.remaining, 1000)
            self.assertEqual(url.max_concurrency, 1)
            with tempfile.TemporaryDirectory() as folder:
                listener = gateway.GatewayListener("", url, post=lambda *_: {"ok": True},
                    status_file=Path(folder) / "status", gap_file=Path(folder) / "gap", sleeper=lambda _: None)
                try: listener.run(max_connections=1)
                finally: listener.stop()
                self.assertEqual(json.loads((Path(folder) / "status").read_text())["session_id"], "session-one")
                self.assertEqual((Path(folder) / "status").stat().st_mode & 0o777, 0o600)
                self.assertFalse(server.errors)
        finally: server.close()

    def test_dispatch_gating_dedupe_heartbeat_reconnect_and_resume(self):
        def first(fixture, stream):
            hello(stream, 30)
            receive_until(stream, 2, fixture)
            send_json(stream, READY)
            send_json(stream, {"op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, content="one")})
            send_json(stream, {"op": 0, "s": 3, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, content="one")})
            send_json(stream, {"op": 0, "s": 4, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, id="not-selected")})
            receive_until(stream, 1, fixture)
            send_frame(stream, 8, struct.pack("!H", 4000))

        def second(fixture, stream):
            hello(stream, 30)
            resume = receive_until(stream, 6, fixture)
            self.assertEqual(resume["d"], {"token": "", "session_id": "session-one", "seq": 4})
            send_json(stream, {"op": 0, "s": 5, "t": "RESUMED", "d": {}})
            send_json(stream, {"op": 0, "s": 6, "t": "MESSAGE_UPDATE", "d": dict(MESSAGE, content="two")})
            send_frame(stream, 8, struct.pack("!H", 4000))

        seen = set()
        connections = []
        def post(path, payload):
            self.assertEqual(path, "/api/discord/internal/live")
            connections.append(listener._status()["connected_since"])
            key = payload["data"]["id"]
            if key == "not-selected": return {"ok": True, "stored": 0, "ignored": 1}
            if (payload["event"], key, payload["data"].get("content")) in seen:
                return {"ok": True, "stored": 0, "ignored": 1}
            seen.add((payload["event"], key, payload["data"].get("content")))
            return {"ok": True, "stored": 1, "ignored": 0}

        server = FakeGateway([first, second]).start()
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                url = gateway.gateway_api("", server.api_url)
            with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=0):
                listener = gateway.GatewayListener("", url, post=post, status_file=Path(folder) / "status",
                    gap_file=Path(folder) / "gap", sleeper=lambda _: None)
                try: listener.run(max_connections=2)
                finally: listener.stop()
                status = json.loads((Path(folder) / "status").read_text())
                self.assertTrue(status["enabled"])
                self.assertIsInstance(status["updated_at"], float)
                self.assertEqual(len(status["event_times"]), 6)
                self.assertEqual(status["received"], 6)  # READY, 3 CREATE, RESUMED, UPDATE
                self.assertEqual(status["stored"], 2)
                self.assertEqual(status["ignored"], 3)  # duplicate, gated, RESUMED
                self.assertEqual(listener.sequence, 6)
                self.assertIsNone(status["connected_since"])  # disconnected after the fixture
                self.assertTrue(all(isinstance(at, float) for at in connections))
                self.assertGreater(connections[-1], connections[0])  # RESUMED starts a new connection age
                self.assertTrue((Path(folder) / "gap").exists())
                self.assertTrue(any(row.get("op") == 1 for row in server.received))
                self.assertFalse(server.errors)
        finally: server.close()

    def test_established_resume_resets_consecutive_failure_backoff(self):
        def first(fixture, stream):
            hello(stream); receive_until(stream, 2, fixture); send_json(stream, READY)
            send_frame(stream, 8, struct.pack("!H", 4000))
        def resumed(sequence):
            def script(fixture, stream):
                hello(stream); receive_until(stream, 6, fixture)
                send_json(stream, {"op": 0, "s": sequence, "t": "RESUMED", "d": {}})
                send_frame(stream, 8, struct.pack("!H", 4000))
            return script
        server = FakeGateway([first, resumed(2), resumed(3)]).start()
        sleeps = []
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                url = gateway.gateway_api("", server.api_url)
            with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=0):
                listener = gateway.GatewayListener("", url, post=lambda *_: {"ok": True},
                    status_file=Path(folder) / "status", gap_file=Path(folder) / "gap", sleeper=sleeps.append)
                try: listener.run(max_connections=3)
                finally: listener.stop()
            self.assertEqual(sleeps, [1, 1])
        finally: server.close()

    def test_failed_pb_event_does_not_advance_sequence_past_failure(self):
        class FakeSocket:
            messages = iter([
                {"op": 10, "d": {"heartbeat_interval": 10000}}, READY,
                {"op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": MESSAGE},
                {"op": 0, "s": 3, "t": "MESSAGE_UPDATE", "d": MESSAGE},
            ])
            @classmethod
            def connect(cls, *_args, **_kwargs): return cls()
            def settimeout(self, _): pass
            def send_json(self, _): pass
            def recv_json(self):
                try: return next(self.messages)
                except StopIteration: raise gateway.WebSocketClosed(4000)
            def abort(self): pass
        calls = 0
        def reject(*_):
            nonlocal calls
            calls += 1
            if calls == 1: raise RuntimeError("no")
            return {"ok": True, "stored": 1, "ignored": 0}
        with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=0):
            listener = gateway.GatewayListener("x", "wss://gateway.discord.gg", post=reject,
                websocket=FakeSocket, status_file=Path(folder) / "status", gap_file=Path(folder) / "gap")
            try: listener.run(max_connections=1)
            finally: listener.stop()
            self.assertEqual(listener.sequence, 1)
            self.assertEqual(calls, 1)

    def test_bounded_queue_reconnects_without_sequence_hole(self):
        messages = [
            {"op": 10, "d": {"heartbeat_interval": 10000}}, READY,
            {"op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, id="two")},
            {"op": 0, "s": 3, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, id="three")},
            {"op": 0, "s": 4, "t": "MESSAGE_CREATE", "d": dict(MESSAGE, id="four")},
        ]
        holder = {}
        class BurstSocket:
            @classmethod
            def connect(cls, *_args, **_kwargs):
                value = cls(); value.index = 0; return value
            def settimeout(self, _): pass
            def send_json(self, _): pass
            def recv_json(self):
                if self.index == 2: holder["listener"]._established.wait(1)
                if self.index == 3: started.wait(1)
                if self.index >= len(messages): raise gateway.WebSocketClosed(4000)
                value = messages[self.index]; self.index += 1; return value
            def abort(self): pass
        started, release = threading.Event(), threading.Event()
        accepted = []
        def slow_post(_path, payload):
            accepted.append(payload["data"]["id"])
            if len(accepted) == 1:
                started.set(); release.wait(1)
            return {"ok": True, "stored": 1, "ignored": 0}
        with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=1):
            listener = gateway.GatewayListener("x", "wss://gateway.discord.gg", post=slow_post,
                websocket=BurstSocket, queue_size=1, status_file=Path(folder) / "status", gap_file=Path(folder) / "gap")
            holder["listener"] = listener
            runner = threading.Thread(target=listener.run, kwargs={"max_connections": 1})
            try:
                runner.start(); self.assertTrue(started.wait(1)); time.sleep(.05); release.set(); runner.join(timeout=2)
                self.assertFalse(runner.is_alive())
                self.assertEqual(accepted, ["two", "three"])
                self.assertEqual(listener.sequence, 3)
                self.assertEqual(listener.received, 4)
                self.assertEqual(listener.stored, 2)
            finally:
                release.set(); listener.stop(); runner.join(timeout=1)

    def test_close_code_policy(self):
        for code in (4004, 4010, 4011, 4012, 4013, 4014): self.assertEqual(gateway.close_action(code), "fatal")
        for code in (1000, 1001, 4007, 4009): self.assertEqual(gateway.close_action(code), "identify")
        self.assertEqual(gateway.close_action(4000), "resume")

    def test_partial_frame_timeout_reconnects_without_reusing_consumed_bytes(self):
        class Partial:
            calls = 0
            def recv(self, _):
                self.calls += 1
                if self.calls == 1: return b"\x81"
                raise socket.timeout
        with self.assertRaises(gateway_ws.WebSocketError):
            gateway_ws._read_exact(Partial(), 2, idle=True)
        class Idle:
            def recv(self, _): raise socket.timeout
        with self.assertRaises(socket.timeout):
            gateway_ws._read_exact(Idle(), 2, idle=True)

    def test_missing_heartbeat_ack_requests_reconnect(self):
        class Sink:
            sent = []
            def send_json(self, value): self.sent.append(value)
        with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=0):
            listener = gateway.GatewayListener("", "ws://127.0.0.1:1", post=lambda *_: {"ok": True},
                status_file=Path(folder) / "status", gap_file=Path(folder) / "gap")
            stopped = threading.Event(); acked = threading.Event(); acked.set(); sink = Sink()
            thread = threading.Thread(target=listener._heartbeat, args=(sink, .01, acked, stopped))
            try:
                thread.start(); thread.join(timeout=.2)
                self.assertTrue(listener._reconnect.is_set())
                self.assertEqual(len(sink.sent), 1)
            finally:
                stopped.set(); thread.join(timeout=1); listener.stop()

    def test_invalid_session_clear_happens_after_stale_dispatch_queue_drains(self):
        class FakeSocket:
            messages = iter([
                {"op": 10, "d": {"heartbeat_interval": 10000}}, READY,
                {"op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": MESSAGE},
                {"op": 0, "s": 3, "t": "READY", "d": {"session_id": "stale", "resume_gateway_url": ""}},
                {"op": 9, "d": False},
            ])
            @classmethod
            def connect(cls, *_args, **_kwargs): return cls()
            def settimeout(self, _): pass
            def send_json(self, _): pass
            def recv_json(self): return next(self.messages)
            def abort(self): pass
        def slow_post(*_):
            time.sleep(.03)
            return {"ok": True, "stored": 1, "ignored": 0}
        with tempfile.TemporaryDirectory() as folder, patch("gateway.random.random", return_value=0):
            listener = gateway.GatewayListener("x", "wss://gateway.discord.gg", post=slow_post,
                websocket=FakeSocket, status_file=Path(folder) / "status", gap_file=Path(folder) / "gap")
            try: listener.run(max_connections=1)
            finally: listener.stop()
            self.assertIsNone(listener.session_id)
            self.assertIsNone(listener.resume_url)
            self.assertIsNone(listener.sequence)

    def test_gateway_bootstrap_retries_transient_and_idles_on_401(self):
        endpoint = gateway.GatewayURL("wss://gateway.discord.gg?v=10", "https://discord.com/api/v10", 1, 60, 1)
        with tempfile.TemporaryDirectory() as folder, patch("gateway.gateway_api", side_effect=[URLError("down"), endpoint]), \
                patch("gateway.random.random", return_value=0):
            status = Path(folder) / "status"
            self.assertEqual(gateway.gateway_with_backoff("x", "api", status, max_attempts=2, sleeper=lambda _: None), endpoint)
            self.assertTrue(status.exists())
        unauthorized = HTTPError("https://discord.com/api/v10/gateway/bot", 401, "", {}, None)
        with tempfile.TemporaryDirectory() as folder, patch("gateway.gateway_api", side_effect=unauthorized):
            status = Path(folder) / "status"
            self.assertIsNone(gateway.gateway_with_backoff("x", "api", status, max_attempts=1))
            self.assertEqual(json.loads(status.read_text())["error"], "Discord authentication failed")

    def test_fatal_message_content_close_is_terminal_and_marks_gap(self):
        def script(fixture, stream):
            hello(stream); receive_until(stream, 2, fixture)
            send_json(stream, READY)
            send_frame(stream, 8, struct.pack("!H", 4014))
        server = FakeGateway([script]).start()
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                url = gateway.gateway_api("", server.api_url)
            with tempfile.TemporaryDirectory() as folder:
                listener = gateway.GatewayListener("", url, post=lambda *_: {"ok": True},
                    status_file=Path(folder) / "status", gap_file=Path(folder) / "gap")
                try: listener.run(max_connections=1)
                finally: listener.stop()
                status = json.loads((Path(folder) / "status").read_text())
                self.assertIn("Message Content", status["error"])
                self.assertTrue((Path(folder) / "gap").exists())
        finally: server.close()

    def test_fixture_rejects_token_before_request(self):
        server = FakeGateway([]).start()
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                with self.assertRaises(RuntimeError): gateway.gateway_api("must-not-leak", server.api_url)
                with self.assertRaises(RuntimeError): gateway.gateway_api("must-not-leak", "https://discord.com/api/v10")
            self.assertEqual(server.gateway_requests, 0)
        finally: server.close()

    def test_session_start_quota_refresh_and_identify_spacing(self):
        server = FakeGateway([], limits=[
            {"remaining": 0, "reset_after": 1500, "max_concurrency": 1},
            {"remaining": 2, "reset_after": 60000, "max_concurrency": 1},
        ]).start()
        now = [10.0]
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds); now[0] += seconds
        try:
            with patch.dict(os.environ, {"DISCORD_PB_FIXTURE": "true"}, clear=False):
                url = gateway.gateway_api("", server.api_url)
                with tempfile.TemporaryDirectory() as folder:
                    listener = gateway.GatewayListener("", url, post=lambda *_: {"ok": True},
                        status_file=Path(folder) / "status", gap_file=Path(folder) / "gap", sleeper=sleep)
                    listener.monotonic = lambda: now[0]
                    listener.identify_reset_at = now[0] + url.reset_after
                    try:
                        listener._wait_identify_quota()
                        listener._record_identify()
                        listener._wait_identify_quota()
                    finally: listener.stop()
            self.assertEqual(server.gateway_requests, 2)
            self.assertEqual(sleeps, [1.5, 5.0])
        finally: server.close()


if __name__ == "__main__": unittest.main()
