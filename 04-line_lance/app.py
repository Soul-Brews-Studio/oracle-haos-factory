#!/usr/bin/env python3
"""CLI and read-only web app for the LINE LanceDB archive."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from store import (
    DEFAULT_SOURCE, chat_summaries, embed_messages, import_pages, list_messages,
    semantic_search, stats, table_info,
)

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE / ".data" / "line.lance"
REACT_DIST = HERE / "frontend" / "dist"
APP_SLUG = os.environ.get("APP_SLUG", "line_lance")
APP_VERSION = os.environ.get("APP_VERSION", "0.3.0")
DATABASE_LABEL = os.environ.get("LANCE_DATABASE_LABEL", "")
SOURCE_LABEL = os.environ.get("LINE_SOURCE_LABEL", "")


class Handler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB

    def log_message(self, format: str, *args: object) -> None:
        print(f"http {self.address_string()} {format % args}")

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def method_not_allowed(self) -> None:
        body = b'{"error":"method not allowed"}'
        self.send_response(405)
        self.send_header("Allow", "GET")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        self.method_not_allowed()

    def do_PUT(self) -> None:  # noqa: N802
        self.method_not_allowed()

    def do_PATCH(self) -> None:  # noqa: N802
        self.method_not_allowed()

    def do_DELETE(self) -> None:  # noqa: N802
        self.method_not_allowed()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                archive = stats(self.db_path)
                return self.send_json({
                    "status": "ok",
                    "slug": APP_SLUG,
                    "version": APP_VERSION,
                    "database": DATABASE_LABEL or str(self.db_path),
                    "messages": archive["messages"],
                    "vectors": archive["vectors"],
                })
            if parsed.path == "/api/stats":
                return self.send_json(stats(self.db_path))
            if parsed.path == "/api/chats":
                return self.send_json({"chats": chat_summaries(self.db_path)})
            if parsed.path == "/api/tables":
                return self.send_json({
                    "tables": table_info(self.db_path),
                    "db_path": DATABASE_LABEL or str(self.db_path),
                    "source": SOURCE_LABEL or str(DEFAULT_SOURCE),
                })
            if parsed.path == "/api/messages":
                value = lambda key, default="": query.get(key, [default])[0]
                return self.send_json(list_messages(
                    self.db_path, q=value("q"), chat=value("chat"), exact_chat=value("exact_chat"),
                    kind=value("type"), day=value("day"), media_only=value("media") == "1",
                    limit=int(value("limit", "50")), offset=int(value("offset", "0")),
                ))
            if parsed.path == "/api/semantic":
                q = query.get("q", [""])[0]
                if not q:
                    return self.send_json({"error": "missing q"}, 400)
                return self.send_json({"matches": semantic_search(self.db_path, q)})
            if not REACT_DIST.is_dir():
                return self.send_json({"error": "React build missing; run `cd frontend && npm run build`"}, 503)
            static = REACT_DIST
            name = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
            target = (static / name).resolve()
            if not target.is_relative_to(static.resolve()):
                return self.send_json({"error": "not found"}, 404)
            if not target.is_file():
                target = static / "index.html"  # React SPA route fallback
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            self.send_json({"error": str(error)}, 500)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--db", type=Path, default=DEFAULT_DB)
    commands = root.add_subparsers(dest="command", required=True)
    imp = commands.add_parser("import", help="import D1 JSON pages")
    imp.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    emb = commands.add_parser("embed", help="embed scalar messages into line_vectors")
    emb.add_argument("--limit", type=int, default=1000)
    commands.add_parser("stats", help="print archive statistics")
    serve = commands.add_parser("serve", help="serve the localhost UI")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=4133)
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "import":
        print(json.dumps(import_pages(args.db, args.source), indent=2))
    elif args.command == "embed":
        print(json.dumps(embed_messages(args.db, args.limit), indent=2))
    elif args.command == "stats":
        print(json.dumps(stats(args.db), ensure_ascii=False, indent=2))
    else:
        Handler.db_path = args.db
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        print(f"LINE LanceDB UI: http://{args.host}:{args.port}  db={args.db}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
