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
STATS = {"after_requests": [], "before_requests": [], "pages": 0, "rate_limits": 0, "authorization_headers": 0, "retry_wait": 0}
LAST_RATE_LIMIT = 0


class Discord(BaseHTTPRequestHandler):
    def do_GET(self):
        global LAST_RATE_LIMIT
        if self.headers.get("Authorization"):
            STATS["authorization_headers"] += 1
            self.send_error(400, "Fixture must not receive credentials")
            return
        path = urlsplit(self.path)
        if path.path == "/health":
            return self.reply({"ok": True})
        if path.path == "/stats":
            return self.reply(STATS)
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
                   if key.lower() not in {"host", "connection", "x-ingress-path", "x-remote-user-id"}}
        headers["X-Ingress-Path"] = prefix
        headers["X-Remote-User-Id"] = self.headers.get("X-Proof-User", "proof-admin")
        headers["Host"] = self.headers["Host"]
        payload = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        conn = HTTPConnection(os.environ["APP_HOST"], 8110, timeout=10)
        conn.request(self.command, self.path[len(prefix):], body=payload, headers=headers)
        response = conn.getresponse()
        body = response.read()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        conn.close()

    do_GET = do_POST = do_PATCH = proxy

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    api = ThreadingHTTPServer(("0.0.0.0", 18080), Discord)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 18111), Ingress).serve_forever()
