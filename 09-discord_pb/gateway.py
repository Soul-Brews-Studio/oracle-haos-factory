#!/usr/bin/env python3
"""Discord Gateway listener; raw events go to PocketBase's private ingest route."""
from collections import deque
import ipaddress
import json
import os
from pathlib import Path
import queue
import random
import socket
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from backfill import pb_post
from gateway_ws import WebSocket, WebSocketClosed, WebSocketError


INTENTS = 1 | 512 | 32768
EVENTS = frozenset({"MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK",
                    "THREAD_CREATE", "THREAD_UPDATE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "GUILD_CREATE"})
FATAL_CLOSE_CODES = frozenset({4004, 4010, 4011, 4012, 4013, 4014})
FRESH_SESSION_CLOSE_CODES = frozenset({1000, 1001, 4007, 4009})


class GatewayFatal(RuntimeError):
    pass


class Reconnect(RuntimeError):
    def __init__(self, message, clear_session=False):
        super().__init__(message)
        self.clear_session = clear_session


class GatewayURL(str):
    """String-compatible URL carrying the cached /gateway/bot identify quota."""
    def __new__(cls, value, api, remaining, reset_after, max_concurrency):
        instance = str.__new__(cls, value)
        instance.api = api
        instance.remaining = remaining
        instance.reset_after = reset_after
        instance.max_concurrency = max_concurrency
        return instance


def load_options(path=None):
    path = path or os.getenv("DISCORD_PB_OPTIONS", "/data/options.json")
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("options must be an object")
    if type(value.get("live", True)) is not bool:
        raise ValueError("live must be boolean")
    token = value.get("bot_token", "")
    if not isinstance(token, str):
        raise ValueError("bot_token must be a string")
    return value


def _private_host(hostname, port):
    if hostname == "localhost":
        return True
    try:
        addresses = {ipaddress.ip_address(hostname)}
    except ValueError:
        try:
            addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(hostname, port)}
        except (OSError, ValueError):
            return False
    return bool(addresses) and all(address.is_private or address.is_loopback for address in addresses)


def fixture_enabled(api):
    if os.getenv("DISCORD_PB_FIXTURE", "").lower() not in {"1", "true", "yes"}:
        return False
    parsed = urlparse(api)
    return parsed.scheme == "http" and bool(parsed.hostname) and _private_host(parsed.hostname, parsed.port)


def fixture_requested():
    return os.getenv("DISCORD_PB_FIXTURE", "").lower() in {"1", "true", "yes"}


def gateway_api(token, api=None):
    api = (api or os.getenv("DISCORD_API_BASE", "https://discord.com/api/v10")).rstrip("/")
    if fixture_requested() and token:
        raise RuntimeError("DISCORD_PB_FIXTURE forbids DISCORD_BOT_TOKEN")
    fixture = fixture_enabled(api)
    parsed = urlparse(api)
    if not fixture and (parsed.scheme != "https" or parsed.hostname not in {"discord.com", "www.discord.com"}):
        raise ValueError("production Discord API must use https://discord.com")
    headers = {"User-Agent": "discord-pb/0.1.8"}
    if token:
        headers["Authorization"] = "Bot " + token
    elif not fixture:
        raise ValueError("bot token is required")
    with urlopen(Request(api + "/gateway/bot", headers=headers), timeout=5) as response:
        body = json.load(response)
    url = body.get("url") if isinstance(body, dict) else None
    if not isinstance(url, str):
        raise ValueError("Discord gateway response is missing url")
    parsed_gateway = urlparse(url)
    if fixture:
        if parsed_gateway.scheme != "ws" or not parsed_gateway.hostname or not _private_host(parsed_gateway.hostname, parsed_gateway.port):
            raise ValueError("fixture gateway must be private ws")
    elif parsed_gateway.scheme != "wss" or parsed_gateway.hostname != "gateway.discord.gg":
        raise ValueError("Discord gateway must use wss://gateway.discord.gg")
    query = dict(parse_qsl(parsed_gateway.query, keep_blank_values=True))
    query.update(v="10", encoding="json")
    limit = body.get("session_start_limit") if isinstance(body, dict) else None
    if not isinstance(limit, dict):
        raise ValueError("Discord gateway response is missing session_start_limit")
    remaining, reset_after, max_concurrency = (limit.get("remaining"), limit.get("reset_after"), limit.get("max_concurrency"))
    if type(remaining) is not int or remaining < 0 or not isinstance(reset_after, (int, float)) or isinstance(reset_after, bool) or reset_after < 0:
        raise ValueError("Discord gateway response has invalid session start quota")
    if type(max_concurrency) is not int or max_concurrency < 1:
        raise ValueError("Discord gateway response has invalid max concurrency")
    value = urlunparse(parsed_gateway._replace(query=urlencode(query)))
    return GatewayURL(value, api, remaining, reset_after / 1000, max_concurrency)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".live-status.", dir=path.parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":")); stream.write("\n")
            stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass


def touch_gap(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("1", encoding="ascii")
    path.chmod(0o600)


def close_action(code):
    if code in FATAL_CLOSE_CODES:
        return "fatal"
    if code in FRESH_SESSION_CLOSE_CODES:
        return "identify"
    return "resume"


class GatewayListener:
    def __init__(self, token, url, post=pb_post, status_file=None, gap_file=None,
                 queue_size=256, websocket=WebSocket, clock=time.time, sleeper=time.sleep):
        self.token, self.url, self.post = token, url, post
        self.status_file = status_file or os.getenv("DISCORD_PB_LIVE_STATUS_FILE", "/data/live-status.json")
        self.gap_file = gap_file or os.getenv("DISCORD_PB_BACKFILL_REQUEST_FILE", "/data/backfill-request")
        self.websocket, self.clock, self.sleeper = websocket, clock, sleeper
        self.monotonic = time.monotonic
        self.identify_remaining = getattr(url, "remaining", None)
        reset_after = getattr(url, "reset_after", None)
        self.identify_reset_at = self.monotonic() + reset_after if reset_after is not None else None
        self.last_identify_at = None
        self.session_id = None
        self.resume_url = None
        self.sequence = None
        self.connected = False
        self.connected_since = None
        self.received = self.stored = self.ignored = 0
        self.event_times = deque()
        self.last_event_at = None
        self.error = None
        self._lock = threading.Lock()
        self._status_write_lock = threading.Lock()
        self._queue = queue.Queue(queue_size)
        self._reconnect = threading.Event()
        self._established = threading.Event()
        self._stop = threading.Event()
        self._dispatch_blocked = False
        self._worker = threading.Thread(target=self._dispatch_worker, daemon=True)
        self._ticker = threading.Thread(target=self._status_ticker, daemon=True)
        self._worker.start()
        self._ticker.start()
        self._write_status()

    def _status(self):
        with self._lock:
            now = self.clock()
            while self.event_times and self.event_times[0] < now - 60:
                self.event_times.popleft()
            return {"enabled": True, "connected": self.connected, "session_id": self.session_id,
                    "updated_at": now, "connected_since": self.connected_since if self.connected else None,
                    "last_event_at": self.last_event_at,
                    "last_event_age": None if self.last_event_at is None else max(0, now - self.last_event_at),
                    "event_times": list(self.event_times), "events_per_minute": len(self.event_times), "received": self.received,
                    "stored": self.stored, "ignored": self.ignored, "error": self.error}

    def _write_status(self):
        # Preserve monotonic snapshots when heartbeat, dispatcher, and ticker race.
        with self._status_write_lock:
            atomic_json(self.status_file, self._status())

    def _status_ticker(self):
        while not self._stop.wait(5):
            self._write_status()

    def _dispatch_worker(self):
        while not self._stop.is_set():
            try:
                item = self._queue.get(timeout=.2)
            except queue.Empty:
                continue
            if item is None:
                self._queue.task_done(); return
            sequence, name, data = item
            try:
                if self._dispatch_blocked:
                    continue
                stored = ignored = 0
                if name == "READY":
                    session = data.get("session_id") if isinstance(data, dict) else None
                    resume = data.get("resume_gateway_url") if isinstance(data, dict) else None
                    if not isinstance(session, str) or not session:
                        raise RuntimeError("READY omitted session id")
                    if resume:
                        candidate = urlparse(resume)
                        initial = urlparse(self.url)
                        production_resume = (initial.scheme == "wss" and initial.hostname == "gateway.discord.gg" and
                            candidate.scheme == "wss" and candidate.port is None and
                            (candidate.hostname == "gateway.discord.gg" or str(candidate.hostname).endswith(".discord.gg")))
                        fixture_resume = (initial.scheme == "ws" and candidate.scheme == "ws" and
                            candidate.hostname == initial.hostname and candidate.port == initial.port)
                        if not (production_resume or fixture_resume):
                            raise RuntimeError("READY returned an untrusted resume URL")
                    with self._lock:
                        self.session_id = session
                        self.resume_url = resume if isinstance(resume, str) else None
                elif name in EVENTS:
                    result = self.post("/api/discord/internal/live", {"event": name, "data": data})
                    if not isinstance(result, dict) or result.get("ok") is not True:
                        raise RuntimeError("PocketBase rejected live event")
                    stored = int(result.get("stored", 0))
                    ignored = int(result.get("ignored", 0))
                    if stored < 0 or ignored < 0:
                        raise RuntimeError("PocketBase returned invalid live counts")
                else:
                    ignored = 1
                if name in {"READY", "RESUMED"}:
                    self._established.set()
                with self._lock:
                    if name in {"READY", "RESUMED"}:
                        self.connected_since = self.clock()
                    self.sequence = sequence
                    self.stored += stored
                    self.ignored += ignored
                    self.error = None
            except Exception as error:
                with self._lock:
                    self.error = type(error).__name__
                    self._dispatch_blocked = True
                self._reconnect.set()
            finally:
                self._write_status()
                self._queue.task_done()

    def _enqueue(self, payload):
        sequence, name, data = payload.get("s"), payload.get("t"), payload.get("d")
        if type(sequence) is not int or not isinstance(name, str):
            raise Reconnect("invalid dispatch envelope")
        now = self.clock()
        with self._lock:
            self.received += 1
            self.last_event_at = now
            self.event_times.append(now)
        try:
            self._queue.put_nowait((sequence, name, data))
        except queue.Full as error:
            with self._lock: self.error = "backpressure"
            raise Reconnect("live event queue full") from error
        self._write_status()

    def _heartbeat(self, ws, interval, acked, stopped):
        if stopped.wait(random.random() * interval):
            return
        while not stopped.is_set():
            if not acked.is_set():
                self._reconnect.set(); return
            acked.clear()
            with self._lock: sequence = self.sequence
            try:
                ws.send_json({"op": 1, "d": sequence})
                self._write_status()
            except OSError:
                self._reconnect.set(); return
            if stopped.wait(interval):
                return

    def _wait_identify_quota(self):
        if self.identify_remaining == 0:
            delay = max(0, (self.identify_reset_at or self.monotonic()) - self.monotonic())
            if delay:
                self.sleeper(delay)
            api = getattr(self.url, "api", None)
            if not api:
                raise GatewayFatal("Discord session start limit exhausted")
            refreshed = gateway_api(self.token, api)
            self.url = refreshed
            self.identify_remaining = refreshed.remaining
            self.identify_reset_at = self.monotonic() + refreshed.reset_after
            if self.identify_remaining == 0:
                raise GatewayFatal("Discord session start limit exhausted")
        if self.last_identify_at is not None:
            delay = 5 - (self.monotonic() - self.last_identify_at)
            if delay > 0:
                self.sleeper(delay)

    def _record_identify(self):
        self.last_identify_at = self.monotonic()
        if self.identify_remaining is not None:
            self.identify_remaining -= 1

    def _run_connection(self):
        self._reconnect.clear()
        self._established.clear()
        with self._lock: resumable = bool(self.session_id and self.sequence is not None)
        if not resumable:
            self._wait_identify_quota()
        target = self.resume_url or self.url
        if self.resume_url:
            parsed = urlparse(target)
            query = dict(parse_qsl(parsed.query, keep_blank_values=True)); query.update(v="10", encoding="json")
            target = urlunparse(parsed._replace(query=urlencode(query)))
        ws = self.websocket.connect(target, timeout=15)
        ws.settimeout(.5)
        heartbeat_stop = threading.Event()
        heartbeat_thread = None
        try:
            hello = ws.recv_json()
            if hello.get("op") != 10 or not isinstance((hello.get("d") or {}).get("heartbeat_interval"), (int, float)):
                raise Reconnect("Gateway did not send HELLO")
            interval = hello["d"]["heartbeat_interval"] / 1000
            if interval <= 0:
                raise Reconnect("invalid heartbeat interval")
            acked = threading.Event(); acked.set()
            heartbeat_thread = threading.Thread(target=self._heartbeat, args=(ws, interval, acked, heartbeat_stop), daemon=True)
            heartbeat_thread.start()
            if resumable:
                ws.send_json({"op": 6, "d": {"token": self.token, "session_id": self.session_id, "seq": self.sequence}})
            else:
                ws.send_json({"op": 2, "d": {"token": self.token, "intents": INTENTS,
                    "properties": {"os": "linux", "browser": "discord-pb", "device": "discord-pb"}}})
                self._record_identify()
            with self._lock: self.connected = True; self.error = None
            self._write_status()
            while not self._reconnect.is_set():
                try:
                    payload = ws.recv_json()
                except socket.timeout:
                    continue
                opcode = payload.get("op")
                if opcode == 0:
                    self._enqueue(payload)
                elif opcode == 1:
                    with self._lock: sequence = self.sequence
                    ws.send_json({"op": 1, "d": sequence})
                elif opcode == 7:
                    raise Reconnect("Gateway requested reconnect")
                elif opcode == 9:
                    raise Reconnect("invalid session", clear_session=payload.get("d") is not True)
                elif opcode == 11:
                    acked.set()
        except WebSocketClosed as error:
            action = close_action(error.code)
            if action == "fatal":
                raise GatewayFatal(f"Gateway close {error.code}") from error
            if action == "identify":
                raise Reconnect(f"Gateway close {error.code}", clear_session=True) from error
            raise Reconnect(f"Gateway close {error.code}") from error
        finally:
            heartbeat_stop.set()
            if heartbeat_thread:
                heartbeat_thread.join(timeout=1)
            ws.abort()
            with self._lock: self.connected = False; self.connected_since = None
            self._write_status()

    def run(self, max_connections=None):
        attempts = 0
        consecutive_failures = 0
        while not self._stop.is_set() and (max_connections is None or attempts < max_connections):
            attempts += 1
            clear_session = False
            try:
                self._run_connection()
            except GatewayFatal as error:
                message = str(error)
                if "4014" in message:
                    message += " (enable the privileged Message Content intent)"
                self._queue.join()
                with self._lock: self.error = message
                self._write_status()
                touch_gap(self.gap_file)
                while max_connections is None and not self._stop.is_set():
                    self.sleeper(3600)
                return
            except Reconnect as error:
                clear_session = error.clear_session
                with self._lock: self.error = type(error).__name__
                self._write_status()
            except (OSError, WebSocketError, ValueError) as error:
                with self._lock: self.error = type(error).__name__
                self._write_status()
            self._queue.join()
            with self._lock:
                self._dispatch_blocked = False
                if clear_session:
                    self.session_id = self.resume_url = self.sequence = None
            self._write_status()
            touch_gap(self.gap_file)
            consecutive_failures = 0 if self._established.is_set() else consecutive_failures + 1
            if max_connections is None or attempts < max_connections:
                self.sleeper(min(60, 2 ** min(max(0, consecutive_failures - 1), 6)) + random.random())

    def stop(self):
        self._stop.set()
        try: self._queue.put_nowait(None)
        except queue.Full: pass
        self._worker.join(timeout=2)
        self._ticker.join(timeout=2)


def wait_for_runtime(token_file, health="http://127.0.0.1:8110/api/health", status=None):
    while True:
        if status:
            idle_status(status, "waiting for PocketBase", True)
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
            if token:
                with urlopen(health, timeout=1) as response:
                    if response.status == 200:
                        return token
        except (FileNotFoundError, OSError, URLError):
            pass
        time.sleep(.5)


def idle_status(path, error, enabled):
    now = time.time()
    atomic_json(path, {"enabled": enabled, "connected": False, "session_id": None,
        "updated_at": now, "event_times": [], "last_event_at": None,
        "last_event_age": None, "events_per_minute": 0, "received": 0, "stored": 0,
        "ignored": 0, "error": error})


def idle_forever(path, error, enabled):
    while True:
        idle_status(path, error, enabled)
        time.sleep(5)


def gateway_with_backoff(token, api, status, max_attempts=None, sleeper=time.sleep):
    attempts = 0
    while max_attempts is None or attempts < max_attempts:
        attempts += 1
        idle_status(status, "connecting", True)
        try:
            return gateway_api(token, api)
        except HTTPError as error:
            if error.code == 401:
                if max_attempts is not None:
                    idle_status(status, "Discord authentication failed", True)
                    return None
                idle_forever(status, "Discord authentication failed", True)
            detail = f"Gateway bootstrap HTTP {error.code}"
        except (URLError, OSError, ValueError, json.JSONDecodeError) as error:
            detail = f"Gateway bootstrap {type(error).__name__}"
        idle_status(status, detail, True)
        if max_attempts is not None and attempts >= max_attempts:
            return None
        remaining = min(60, 2 ** min(attempts - 1, 6)) + random.random()
        while remaining > 0:
            delay = min(5, remaining)
            sleeper(delay)
            remaining -= delay
            idle_status(status, detail, True)


def main():
    status = os.getenv("DISCORD_PB_LIVE_STATUS_FILE", "/data/live-status.json")
    options = load_options()
    if not options.get("live", True):
        idle_forever(status, "disabled", False)
    token = options.get("bot_token", "")
    api = os.getenv("DISCORD_API_BASE", "https://discord.com/api/v10")
    if not token and not fixture_enabled(api):
        idle_forever(status, "bot token not configured", True)
    internal = wait_for_runtime(os.getenv("DISCORD_PB_INTERNAL_TOKEN_FILE", "/run/discord-pb/internal-token"), status=status)
    os.environ["DISCORD_PB_INTERNAL_TOKEN"] = internal
    url = gateway_with_backoff(token, api, status)
    listener = GatewayListener(token, url, status_file=status)
    try: listener.run()
    finally: listener.stop()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, HTTPError, URLError, json.JSONDecodeError) as error:
        # Never render URLs, bodies, options, or credentials.
        print(f"discord_pb gateway failed: {type(error).__name__}", flush=True)
