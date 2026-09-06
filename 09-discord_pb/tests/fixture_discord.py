#!/usr/bin/env python3
"""Token-free Discord-shaped API backed by a read-only archive for local proof."""
import json, os, re, sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DB = os.environ["SQLITE_DB"]
CHANNELS = set(os.environ["CHANNELS"].split(","))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/channels/(\d+)/messages", parsed.path)
        if not match or match.group(1) not in CHANNELS:
            self.send_error(404); return
        channel = match.group(1); query = parse_qs(parsed.query)
        limit = min(int(query.get("limit", [100])[0]), 100)
        before = query.get("before", [None])[0]
        sql = "SELECT * FROM discord_messages WHERE (channel_id=? OR thread_id=?)"
        args = [channel, channel]
        if before: sql += " AND CAST(message_id AS INTEGER) < CAST(? AS INTEGER)"; args.append(before)
        sql += " ORDER BY CAST(message_id AS INTEGER) DESC LIMIT ?"; args.append(limit)
        db = sqlite3.connect("file:" + DB + "?mode=ro&immutable=1", uri=True); db.row_factory = sqlite3.Row
        rows = db.execute(sql, args).fetchall(); db.close()
        out = []
        for row in rows:
            out.append({"id": row["message_id"], "channel_id": channel, "guild_id": row["guild_id"],
              "author": {"id": row["author_id"], "username": row["author_name"], "bot": bool(row["author_is_bot"])},
              "content": row["content"], "attachments": json.loads(row["attachments_json"] or "[]"),
              "embeds": [], "timestamp": row["ts"], "edited_timestamp": None})
        body = json.dumps(out).encode(); self.send_response(200)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

ThreadingHTTPServer(("0.0.0.0", 18080), Handler).serve_forever()
