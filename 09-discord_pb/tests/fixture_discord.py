#!/usr/bin/env python3
"""Local-only Discord API + ingress stand-in; never contacts Discord or HA."""
import json
import os
import re
import threading
import time
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

DATA = json.loads(Path(os.environ["FIXTURE_JSON"]).read_text())
STATS = {"after_requests": [], "before_requests": [], "pages": 0, "rate_limits": 0, "authorization_headers": 0, "retry_wait": 0, "guild_walks": 0, "archived_requests": 0, "writes": []}
LAST_RATE_LIMIT = 0
NEXT_ID = 900000000300000000
WRITE_SNAPSHOT = None


class Discord(BaseHTTPRequestHandler):
    def reject_credentials(self):
        if not self.headers.get("Authorization"):
            return False
        STATS["authorization_headers"] += 1
        self.send_error(400, "Fixture must not receive credentials")
        return True

    def json_body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def write_event(self, kind, path):
        # Deliberately metadata-only: never retain message or starter text.
        STATS["writes"].append({"method": self.command, "kind": kind, "path": path})

    def snowflake(self):
        global NEXT_ID
        NEXT_ID += 1
        return str(NEXT_ID)

    def do_GET(self):
        global LAST_RATE_LIMIT
        if self.reject_credentials(): return
        path = urlsplit(self.path)
        if path.path == "/health":
            return self.reply({"ok": True})
        if path.path == "/stats":
            return self.reply(STATS)
        guild_ids = sorted({row["metadata"].get("guild_id") for row in DATA.values() if row["metadata"].get("guild_id")})
        if path.path == "/users/@me/guilds":
            return self.reply([{"id": gid, "name": "Proof Guild" if gid == "900000000000000002" else "Guild " + gid} for gid in guild_ids])
        guild = re.fullmatch(r"/guilds/(\d+)(/channels|/threads/active)?", path.path)
        if guild and guild[1] in guild_ids:
            if guild[2] == "/channels":
                STATS["guild_walks"] += 1
                if guild[1] == "900000000000000002" and STATS["guild_walks"] >= 2:
                    DATA["900000000000000005"] = {"metadata": {
                        "id": "900000000000000005", "name": "proof-new-thread", "type": 11,
                        "parent_id": "900000000000000004", "guild_id": guild[1]}, "messages": []}
                return self.reply([row["metadata"] for row in DATA.values() if row["metadata"].get("guild_id") == guild[1] and row["metadata"].get("type") not in {10,11,12}])
            if guild[2] == "/threads/active":
                return self.reply({"threads": [row["metadata"] for row in DATA.values() if row["metadata"].get("guild_id") == guild[1] and row["metadata"].get("type") in {10,11,12} and not row["metadata"].get("thread_metadata", {}).get("archived")]})
            return self.reply({"id": guild[1], "name": "Proof Guild" if guild[1] == "900000000000000002" else "Guild " + guild[1]})
        archived = re.fullmatch(r"/channels/(\d+)/(?:users/@me/)?threads/archived/(public|private)", path.path)
        if archived:
            STATS["archived_requests"] += 1
            rows = [row["metadata"] for row in DATA.values()
                    if row["metadata"].get("parent_id") == archived[1]
                    and row["metadata"].get("thread_metadata", {}).get("archived")
                    and (row["metadata"].get("type") == 12) == (archived[2] == "private")]
            return self.reply({"threads": rows, "has_more": False})
        message = re.fullmatch(r"/channels/(\d+)/messages/(\d+)", path.path)
        if message:
            rows = DATA.get(message[1], {}).get("messages", [])
            found = next((row for row in rows if row["id"] == message[2]), None)
            return self.reply(found, 200) if found else self.send_error(404)
        match = re.fullmatch(r"/channels/(\d+)(/messages)?", path.path)
        if not match or match[1] not in DATA:
            self.send_error(404)
            return
        channel = DATA[match[1]]
        if not match[2]:
            return self.reply(channel["metadata"])
        if channel.get("rate_limit") and not STATS["rate_limits"]:
            STATS["rate_limits"] += 1
            LAST_RATE_LIMIT = time.monotonic()
            return self.reply({"retry_after": .12, "global": True}, 429, {"Retry-After": "0.08"})
        if LAST_RATE_LIMIT and not STATS["retry_wait"]:
            STATS["retry_wait"] = time.monotonic() - LAST_RATE_LIMIT
        query = parse_qs(path.query)
        before = int(query.get("before", [10**21])[0])
        limit = min(int(query.get("limit", [100])[0]), 100)
        after = int(query.get("after", [0])[0])
        if "after" in query:
            STATS["after_requests"].append({"channel": match[1], "after": str(after)})
        else:
            STATS["before_requests"].append({"channel": match[1], "before": str(before)})
        rows = [row for row in channel["messages"] if after < int(row["id"]) < before]
        rows.sort(key=lambda row: int(row["id"]), reverse="after" not in query)
        STATS["pages"] += 1
        return self.reply(rows[:limit])

    def do_POST(self):
        global WRITE_SNAPSHOT, DATA
        if self.reject_credentials(): return
        path = urlsplit(self.path).path
        # Fixture-only cleanup, so write probes cannot contaminate later import proofs.
        if path == "/_fixture/restore-writes":
            if WRITE_SNAPSHOT is not None:
                DATA = json.loads(WRITE_SNAPSHOT)
                WRITE_SNAPSHOT = None
            return self.reply({"ok": True})
        if WRITE_SNAPSHOT is None:
            WRITE_SNAPSHOT = json.dumps(DATA)
        body = self.json_body()
        message = re.fullmatch(r"/channels/(\d+)/messages", path)
        if message and message[1] in DATA:
            message_id = self.snowflake()
            row = {"id": message_id, "channel_id": message[1], "content": body.get("content", ""),
                   "timestamp": "2026-09-06T13:30:00.000Z", "author": {"id": "900000000000000003", "username": "Fixture"},
                   "attachments": [], "embeds": [], "pinned": False}
            DATA[message[1]]["messages"].append(row)
            self.write_event("message", path)
            return self.reply(row, 201)
        from_message = re.fullmatch(r"/channels/(\d+)/messages/(\d+)/threads", path)
        if from_message and from_message[1] in DATA:
            if not any(row["id"] == from_message[2] for row in DATA[from_message[1]]["messages"]):
                return self.send_error(404)
            thread_id = self.snowflake()
            metadata = {"id": thread_id, "name": body.get("name", "fixture-thread"), "type": 11,
                        "parent_id": from_message[1], "guild_id": DATA[from_message[1]]["metadata"].get("guild_id"),
                        "thread_metadata": {"archived": False}}
            DATA[thread_id] = {"metadata": metadata, "messages": []}
            self.write_event("thread", path)
            return self.reply(metadata, 201)
        forum = re.fullmatch(r"/channels/(\d+)/threads", path)
        if forum and forum[1] in DATA and DATA[forum[1]]["metadata"].get("type") in {15, 16}:
            thread_id = self.snowflake()
            metadata = {"id": thread_id, "name": body.get("name", "fixture-forum-thread"), "type": 11,
                        "parent_id": forum[1], "guild_id": DATA[forum[1]]["metadata"].get("guild_id"),
                        "thread_metadata": {"archived": False}}
            DATA[thread_id] = {"metadata": metadata, "messages": []}
            self.write_event("forum-thread", path)
            return self.reply(metadata, 201)
        self.send_error(404)

    def do_PUT(self):
        if self.reject_credentials(): return
        path = urlsplit(self.path).path
        pin = re.fullmatch(r"/channels/(\d+)/messages/pins/(\d+)", path)
        if not pin or pin[1] not in DATA: return self.send_error(404)
        row = next((item for item in DATA[pin[1]]["messages"] if item["id"] == pin[2]), None)
        if not row: return self.send_error(404)
        row["pinned"] = True
        self.write_event("pin", path)
        self.send_response(204); self.end_headers()

    def do_PATCH(self):
        if self.reject_credentials(): return
        path = urlsplit(self.path).path
        channel = re.fullmatch(r"/channels/(\d+)", path)
        if not channel or channel[1] not in DATA: return self.send_error(404)
        body = self.json_body()
        if "archived" in body:
            DATA[channel[1]]["metadata"].setdefault("thread_metadata", {})["archived"] = bool(body["archived"])
        self.write_event("channel", path)
        return self.reply(DATA[channel[1]]["metadata"])

    def reply(self, value, status=200, headers=None):
        body = json.dumps(value).encode()
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class Ingress(BaseHTTPRequestHandler):
    def proxy(self):
        prefix = "/api/hassio_ingress/discord-proof"
        if self.path == prefix:
            self.send_response(302)
            self.send_header("Location", prefix + "/")
            self.end_headers()
            return
        if not self.path.startswith(prefix + "/"):
            self.send_error(404)
            return
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in {"host", "connection", "x-ingress-path", "x-remote-user-id", "x-remote-user-name"}}
        headers["X-Ingress-Path"] = prefix
        headers["X-Remote-User-Id"] = self.headers.get("X-Proof-User", "proof-admin")
        headers["X-Remote-User-Name"] = self.headers.get("X-Proof-User-Name", "Proof Admin")
        headers["Host"] = self.headers["Host"]
        payload = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        conn = HTTPConnection(os.environ["APP_HOST"], 8110, timeout=10)
        conn.request(self.command, self.path[len(prefix):], body=payload, headers=headers)
        response = conn.getresponse()
        if response.getheader("Content-Type", "").startswith("text/event-stream"):
            # Preserve streaming through the simulated HA ingress; buffering the
            # entire body hides PB_CONNECT and deadlocks authenticated subscribe.
            self.send_response(response.status)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            conn.sock.settimeout(330)
            try:
                while True:
                    line = response.readline()
                    if not line: break
                    self.wfile.write(line); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            finally:
                conn.close()
            return
        body = response.read()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        conn.close()

    do_GET = do_POST = do_PATCH = do_DELETE = proxy

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    api = ThreadingHTTPServer(("0.0.0.0", 18080), Discord)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 18111), Ingress).serve_forever()
