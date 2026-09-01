"""Localhost-only, read-only HTTP browser for the canonical records table."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
from collections import Counter, defaultdict
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from .embeddings import EmbeddingProvider, EmbeddingUnavailable
from .rag import rag_query, rag_stats
from .schema import SCHEMA_VERSION, TEXT_TRANSFORM_VERSION, arrow_schema
from .semantic import (
    SEMANTIC_TOPIC_POINTS_TABLE,
    SEMANTIC_TOPICS_TABLE,
    lexical_search,
    merge_ranked_hits,
    semantic_search,
    semantic_stats,
)
from .store import RECORDS_TABLE, connect_db

_BIND_HOST = "127.0.0.1"
_MAX_BODY_BYTES = 4096
_MAX_LIMIT = 100
_MAX_QUERY_CHARS = 200
_RECORD_ID = re.compile(r"[0-9a-f]{64}\Z")
_KNOWN_RECORD_TYPES = frozenset(
    {"message", "post", "comment", "group_post", "group_comment", "event"}
)
_FEED_RECORD_TYPES = _KNOWN_RECORD_TYPES - {"message"}
_STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/studio.css": ("studio.css", "text/css; charset=utf-8"),
    "/studio.js": ("studio.js", "text/javascript; charset=utf-8"),
}
_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'none'; media-src 'none'; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    ),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


class _BadRequest(Exception):
    """A request that can be rejected without exposing its contents."""


class StudioServer(ThreadingHTTPServer):
    """HTTP server carrying only the private database URI in process memory."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        db_uri: str | Path,
        port: int,
        embedding_provider: EmbeddingProvider | None = None,
    ) -> None:
        self.db_uri = str(db_uri)
        self.embedding_provider = embedding_provider
        self.cursor_secret = secrets.token_bytes(32)
        super().__init__((_BIND_HOST, port), StudioRequestHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # The standard implementation prints exception details. Storage errors can
        # contain paths or values from the private archive, so remain silent.
        _ = request, client_address


def create_server(
    db_uri: str | Path,
    port: int = 8791,
    embedding_provider: EmbeddingProvider | None = None,
) -> StudioServer:
    """Create a server that can only listen on the IPv4 loopback interface."""

    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")

    # Studio intentionally supports local filesystem databases only. LanceDB can
    # create a directory when connecting to a missing path, so reject that case
    # before opening anything as well.
    uri = str(db_uri)
    if "://" in uri:
        raise ValueError("Studio requires a local database")
    if not Path(uri).is_dir():
        raise FileNotFoundError(uri)

    db = connect_db(uri)
    if RECORDS_TABLE not in db.list_tables().tables:
        raise FileNotFoundError(RECORDS_TABLE)
    db.open_table(RECORDS_TABLE)  # Validate readability before announcing the URL.
    return StudioServer(uri, port, embedding_provider)


def serve(
    db_uri: str | Path,
    port: int = 8791,
    embedding_provider: EmbeddingProvider | None = None,
) -> None:
    """Serve Studio until interrupted, without logging requests or data."""

    server = create_server(db_uri, port, embedding_provider)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


class StudioRequestHandler(BaseHTTPRequestHandler):
    """Small, closed HTTP surface for browsing records without mutations."""

    protocol_version = "HTTP/1.1"

    @property
    def _studio_server(self) -> StudioServer:
        """Return the server state attached by ``StudioServer``."""

        return cast(StudioServer, self.server)

    def log_message(self, format: str, *args: Any) -> None:
        # Request targets and failures may include private query text.
        _ = format, args

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # The base implementation returns HTML containing request metadata and
        # omits Studio's security headers.
        _ = message, explain
        if code == 501:
            self._method_not_allowed()
        else:
            self._json_response(code, {"error": "request_rejected"})

    def do_GET(self) -> None:
        if not self._host_allowed():
            self._json_response(421, {"error": "invalid_host"})
            return

        path = urlsplit(self.path).path
        try:
            if path == "/api/status":
                self._json_response(200, self._status())
            elif path == "/api/schema":
                self._json_response(200, self._schema())
            elif path.startswith("/api/records/"):
                self._record(path.removeprefix("/api/records/"))
            elif path in _STATIC_ROUTES:
                self._static(path)
            else:
                self._json_response(404, {"error": "not_found"})
        except Exception:  # noqa: BLE001 - privacy boundary for storage failures
            self._json_response(500, {"error": "unavailable"})

    def do_POST(self) -> None:
        # A one-request connection prevents unread or malformed bodies from being
        # interpreted as a second request on the same socket.
        self.close_connection = True
        if not self._host_allowed():
            self._json_response(421, {"error": "invalid_host"})
            return
        if not self._origin_allowed():
            self._json_response(403, {"error": "invalid_origin"})
            return

        path = urlsplit(self.path).path
        handlers = {
            "/api/records/query": self._query,
            "/api/feed/query": self._feed_query,
            "/api/chats/query": self._chats_query,
            "/api/chats/thread": self._chat_thread,
            "/api/rag/query": self._rag_query,
            "/api/search/semantic": self._semantic_query,
            "/api/topics/query": self._topics_query,
            "/api/topics/records": self._topic_records,
        }
        handler = handlers.get(path)
        if handler is None:
            self._json_response(404, {"error": "not_found"})
            return
        try:
            request = self._read_query_request()
            self._json_response(200, handler(request))
        except _BadRequest:
            self._json_response(400, {"error": "invalid_request"})
        except (EmbeddingUnavailable, FileNotFoundError):
            self._json_response(503, {"error": "unavailable"})
        except Exception:  # noqa: BLE001 - never expose private storage errors
            self._json_response(500, {"error": "unavailable"})

    def do_PUT(self) -> None:
        self._method_not_allowed()

    def do_PATCH(self) -> None:
        self._method_not_allowed()

    def do_DELETE(self) -> None:
        self._method_not_allowed()

    def do_OPTIONS(self) -> None:
        self._method_not_allowed()

    def do_HEAD(self) -> None:
        self._method_not_allowed()

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self._json_response(
            405, {"error": "method_not_allowed"}, {"Allow": "GET, POST"}
        )

    def _host_allowed(self) -> bool:
        host = self.headers.get("Host", "")
        name, separator, port = host.rpartition(":")
        if not separator:
            name, port = host, ""
        if name.casefold() not in {_BIND_HOST, "localhost"}:
            return False
        return (not separator and not port) or (bool(port) and port.isdigit())

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed = urlsplit(origin)
        if (
            parsed.scheme != "http"
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            return False
        return parsed.netloc.casefold() == self.headers.get("Host", "").casefold()

    def _status(self) -> dict[str, Any]:
        rows = self._rows(["record_type"])
        counts = Counter(row["record_type"] for row in rows)
        derived = semantic_stats(self._studio_server.db_uri)
        retrieval = rag_stats(
            self._studio_server.db_uri,
            semantic_generation=derived["semantic_generation"],
        )
        return {
            "ready": True,
            "read_only": True,
            "table": RECORDS_TABLE,
            "row_count": len(rows),
            "by_type": dict(sorted(counts.items())),
            "schema_version": SCHEMA_VERSION,
            "text_transform_version": TEXT_TRANSFORM_VERSION,
            "semantic": {
                "index_ready": derived["ready"],
                "lexical_ready": derived["ready"],
                "query_ready": bool(
                    derived["ready"] and self._studio_server.embedding_provider is not None
                ),
                "chunks": derived["chunks"],
                "topics": derived["topics"],
                "topic_points": derived["topic_points"],
                "vector_space_id": derived["vector_space_id"],
                "rag_ready": retrieval["ready"],
                "retrieval_documents": retrieval["documents"],
                "joined_post_threads": retrieval["joined_post_threads"],
                "standalone_comments": retrieval["standalone_comments"],
            },
        }

    def _schema(self) -> dict[str, Any]:
        fields = [
            {
                "name": field.name,
                "arrow_type": str(field.type),
                "type": str(field.type),
                "nullable": field.nullable,
            }
            for field in arrow_schema()
        ]
        return {"table": RECORDS_TABLE, "fields": fields}

    def _record(self, record_id: str) -> None:
        if not _RECORD_ID.fullmatch(record_id):
            self._json_response(404, {"error": "not_found"})
            return
        record = next(
            (row for row in self._rows() if row["record_id"] == record_id), None
        )
        if record is None:
            self._json_response(404, {"error": "not_found"})
            return
        self._json_response(200, _bounded_record(record))

    def _read_query_request(self) -> dict[str, Any]:
        if self.headers.get("Transfer-Encoding"):
            raise _BadRequest
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise _BadRequest
        try:
            length = int(raw_length)
        except ValueError as error:
            raise _BadRequest from error
        if not 0 <= length <= _MAX_BODY_BYTES:
            self.close_connection = True
            raise _BadRequest
        content_type = self.headers.get_content_type()
        if content_type != "application/json":
            raise _BadRequest
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise _BadRequest from error
        if not isinstance(value, dict):
            raise _BadRequest
        return value

    def _query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        allowed_keys = {"record_types", "query", "sort", "limit", "cursor"}
        if set(request) - allowed_keys:
            raise _BadRequest

        record_types = request.get("record_types", [])
        if not isinstance(record_types, list) or any(
            not isinstance(item, str) for item in record_types
        ):
            raise _BadRequest
        selected_types = set(record_types)
        if (
            len(selected_types) != len(record_types)
            or not selected_types <= _KNOWN_RECORD_TYPES
        ):
            raise _BadRequest

        query = request.get("query", "")
        if not isinstance(query, str) or len(query) > _MAX_QUERY_CHARS:
            raise _BadRequest
        query_folded = query.casefold().strip()

        sort = request.get("sort", "newest")
        if sort not in {"newest", "oldest"}:
            raise _BadRequest
        limit = request.get("limit", 50)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _MAX_LIMIT
        ):
            raise _BadRequest

        fingerprint = _cursor_fingerprint(
            "records", sorted(selected_types), query_folded, sort, limit
        )
        cursor = request.get("cursor")
        offset = (
            0
            if cursor is None
            else _decode_cursor(cursor, fingerprint, self._studio_server.cursor_secret)
        )

        rows = self._rows()
        if selected_types:
            rows = [row for row in rows if row["record_type"] in selected_types]
        if query_folded:
            rows = [
                row
                for row in rows
                if query_folded in (row.get("text") or "").casefold()
                or query_folded in (row.get("author") or "").casefold()
            ]
        if sort == "newest":
            rows.sort(key=_newest_sort_key)
        else:
            rows.sort(key=_oldest_sort_key)

        page = rows[offset : offset + limit]
        next_offset = offset + len(page)
        next_cursor = (
            _encode_cursor(next_offset, fingerprint, self._studio_server.cursor_secret)
            if next_offset < len(rows)
            else None
        )
        return {
            "items": [_record_summary(row) for row in page],
            "matched_count": len(rows),
            "next_cursor": next_cursor,
            "has_more": next_cursor is not None,
        }

    def _feed_query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        allowed_keys = {"record_types", "query", "limit", "cursor"}
        if set(request) - allowed_keys:
            raise _BadRequest

        record_types = request.get("record_types", [])
        if not isinstance(record_types, list) or any(
            not isinstance(item, str) for item in record_types
        ):
            raise _BadRequest
        selected_types = set(record_types)
        if (
            len(selected_types) != len(record_types)
            or not selected_types <= _FEED_RECORD_TYPES
        ):
            raise _BadRequest
        effective_types = selected_types or _FEED_RECORD_TYPES
        query_folded, limit = _query_and_limit(request)
        fingerprint = _cursor_fingerprint(
            "feed", sorted(effective_types), query_folded, limit
        )
        offset = _request_offset(
            request.get("cursor"), fingerprint, self._studio_server.cursor_secret
        )

        rows = [row for row in self._rows() if row["record_type"] in effective_types]
        if query_folded:
            rows = [
                row
                for row in rows
                if query_folded in (row.get("text") or "").casefold()
                or query_folded in (row.get("author") or "").casefold()
            ]
        rows.sort(key=_newest_sort_key)
        return _page_response(
            rows,
            offset,
            limit,
            fingerprint,
            self._studio_server.cursor_secret,
            _feed_summary,
        )

    def _chats_query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if set(request) - {"query", "sort", "limit", "cursor"}:
            raise _BadRequest
        query_folded, limit = _query_and_limit(request)
        sort = request.get("sort", "newest")
        if sort not in {"newest", "oldest"}:
            raise _BadRequest
        fingerprint = _cursor_fingerprint("chats", query_folded, sort, limit)
        offset = _request_offset(
            request.get("cursor"), fingerprint, self._studio_server.cursor_secret
        )

        grouped = _message_threads(self._rows())
        threads: list[dict[str, Any]] = []
        for thread_id, messages in grouped.items():
            label = _thread_display_label(thread_id, messages)
            if query_folded and not (
                query_folded in label.casefold()
                or any(
                    query_folded in (message.get("text") or "").casefold()
                    for message in messages
                )
            ):
                continue
            latest = min(messages, key=_newest_sort_key)
            threads.append(
                {
                    "thread_id": thread_id,
                    "display_label": label,
                    "latest_preview": _bounded_text(latest.get("text"), 240),
                    "latest_time_ms": latest.get("event_time_ms"),
                    "message_count": len(messages),
                }
            )
        threads.sort(
            key=_thread_newest_sort_key if sort == "newest" else _thread_oldest_sort_key
        )
        return _page_response(
            threads,
            offset,
            limit,
            fingerprint,
            self._studio_server.cursor_secret,
            dict,
        )

    def _chat_thread(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if set(request) - {"thread_id", "limit", "cursor"}:
            raise _BadRequest
        thread_id = request.get("thread_id")
        if not isinstance(thread_id, str) or not _RECORD_ID.fullmatch(thread_id):
            raise _BadRequest
        _, limit = _query_and_limit(request, allow_query=False)
        fingerprint = _cursor_fingerprint("chat-thread", thread_id, limit)
        offset = _request_offset(
            request.get("cursor"), fingerprint, self._studio_server.cursor_secret
        )

        messages = _message_threads(self._rows()).get(thread_id, [])
        messages.sort(key=_newest_sort_key)
        page = messages[offset : offset + limit]
        next_offset = offset + len(page)
        next_cursor = (
            _encode_cursor(next_offset, fingerprint, self._studio_server.cursor_secret)
            if next_offset < len(messages)
            else None
        )
        page.sort(key=_oldest_sort_key)
        return {
            "items": [_chat_message_summary(message) for message in page],
            "matched_count": len(messages),
            "display_label": _thread_display_label(thread_id, messages),
            "next_cursor": next_cursor,
            "has_more": next_cursor is not None,
        }

    def _semantic_query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if set(request) - {"query", "limit"}:
            raise _BadRequest
        query = request.get("query", "")
        if not isinstance(query, str) or len(query) > _MAX_QUERY_CHARS:
            raise _BadRequest
        query = query.strip()
        limit = request.get("limit", 50)
        if (
            not query
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 50
        ):
            raise _BadRequest
        candidate_limit = min(50, max(limit * 2, limit))
        lexical_hits = lexical_search(
            self._studio_server.db_uri, query, limit=candidate_limit
        )
        semantic_hits: list[dict[str, Any]] = []
        semantic_used = False
        if self._studio_server.embedding_provider is not None:
            try:
                semantic_hits = semantic_search(
                    self._studio_server.db_uri,
                    self._studio_server.embedding_provider,
                    query,
                    limit=candidate_limit,
                )
                semantic_used = True
            except EmbeddingUnavailable:
                # The local lexical indexes remain useful when the trusted
                # embedding service is temporarily unavailable.
                pass
        hits = merge_ranked_hits(
            semantic_hits, lexical_hits, limit=limit
        )
        records = {row["record_id"]: row for row in self._rows()}
        items: list[dict[str, Any]] = []
        for hit in hits:
            record = records.get(hit["record_id"])
            if record is None:
                continue
            summary = _record_summary(record)
            summary.update(
                {
                    "match_kind": hit["match_kind"],
                    "matched_chunk_index": hit["chunk_index"],
                }
            )
            if "distance" in hit:
                summary["distance"] = hit["distance"]
            items.append(summary)
        mode = "hybrid" if semantic_used and lexical_hits else (
            "semantic" if semantic_used else "lexical"
        )
        return {"items": items, "matched_count": len(items), "mode": mode}

    def _rag_query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Retrieve logical documents and bounded, citable canonical context."""

        if set(request) - {"query", "limit"}:
            raise _BadRequest
        query = request.get("query", "")
        limit = request.get("limit", 10)
        if (
            not isinstance(query, str)
            or not query.strip()
            or len(query) > _MAX_QUERY_CHARS
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 10
        ):
            raise _BadRequest
        return rag_query(
            self._studio_server.db_uri,
            self._studio_server.embedding_provider,
            query.strip(),
            limit=limit,
        )

    def _topics_query(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if set(request) - {"limit"}:
            raise _BadRequest
        _, limit = _query_and_limit(request, allow_query=False)
        db = connect_db(self._studio_server.db_uri)
        derived = semantic_stats(self._studio_server.db_uri)
        generation = derived["semantic_generation"]
        if not generation or not derived["topics"] or not derived["topic_points"]:
            raise FileNotFoundError(SEMANTIC_TOPICS_TABLE)
        names = set(db.list_tables().tables)
        if not {SEMANTIC_TOPICS_TABLE, SEMANTIC_TOPIC_POINTS_TABLE} <= names:
            raise FileNotFoundError(SEMANTIC_TOPICS_TABLE)
        topics_table = db.open_table(SEMANTIC_TOPICS_TABLE)
        points_table = db.open_table(SEMANTIC_TOPIC_POINTS_TABLE)
        topic_count = derived["topics"]
        point_count = derived["topic_points"]
        topics = (
            topics_table.search()
            .where(f"semantic_generation = '{generation}'")
            .limit(topic_count)
            .to_arrow()
            .to_pylist()
            if topic_count
            else []
        )
        points = (
            points_table.search()
            .where(f"semantic_generation = '{generation}'")
            .limit(point_count)
            .to_arrow()
            .to_pylist()
            if point_count
            else []
        )
        positions: dict[str, list[tuple[float, float]]] = defaultdict(list)
        for point in points:
            positions[point["topic_id"]].append((point["x"], point["y"]))
        topics.sort(key=lambda topic: (-int(topic["size"]), topic["topic_id"]))
        items = []
        for topic in topics[:limit]:
            coordinates = positions.get(topic["topic_id"], [])
            x = (
                sum(value[0] for value in coordinates) / len(coordinates)
                if coordinates
                else 0.0
            )
            y = (
                sum(value[1] for value in coordinates) / len(coordinates)
                if coordinates
                else 0.0
            )
            items.append(
                {
                    "topic_id": topic["topic_id"],
                    "label": _bounded_text(topic["label"], 256),
                    "size": topic["size"],
                    "keywords": [
                        _bounded_text(keyword, 80) for keyword in topic["keywords"][:5]
                    ],
                    "x": x,
                    "y": y,
                }
            )
        return {"items": items, "matched_count": len(topics)}

    def _topic_records(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if set(request) - {"topic_id", "limit"}:
            raise _BadRequest
        topic_id = request.get("topic_id")
        if not isinstance(topic_id, str) or not _RECORD_ID.fullmatch(topic_id):
            raise _BadRequest
        _, limit = _query_and_limit(request, allow_query=False)
        db = connect_db(self._studio_server.db_uri)
        derived = semantic_stats(self._studio_server.db_uri)
        generation = derived["semantic_generation"]
        if not generation or not derived["topics"] or not derived["topic_points"]:
            raise FileNotFoundError(SEMANTIC_TOPIC_POINTS_TABLE)
        if SEMANTIC_TOPIC_POINTS_TABLE not in db.list_tables().tables:
            raise FileNotFoundError(SEMANTIC_TOPIC_POINTS_TABLE)
        table = db.open_table(SEMANTIC_TOPIC_POINTS_TABLE)
        count = derived["topic_points"]
        points = (
            table.search()
            .where(f"semantic_generation = '{generation}'")
            .limit(count)
            .to_arrow()
            .to_pylist()
            if count
            else []
        )
        selected = [point for point in points if point["topic_id"] == topic_id]
        selected.sort(key=lambda point: (point["distance"], point["record_id"]))
        records = {row["record_id"]: row for row in self._rows()}
        items = []
        for point in selected[:limit]:
            record = records.get(point["record_id"])
            if record is None:
                continue
            summary = _record_summary(record)
            summary.update(
                {
                    "x": point["x"],
                    "y": point["y"],
                    "distance": point["distance"],
                }
            )
            items.append(summary)
        return {"items": items, "matched_count": len(selected)}

    def _rows(self, columns: list[str] | None = None) -> list[dict[str, Any]]:
        db = connect_db(self._studio_server.db_uri)
        table = db.open_table(RECORDS_TABLE)
        count = table.count_rows()
        if not count:
            return []
        query = table.search()
        if columns is not None:
            query = query.select(columns)
        return query.limit(count).to_arrow().to_pylist()

    def _static(self, path: str) -> None:
        filename, content_type = _STATIC_ROUTES[path]
        content = (
            resources.files("facebook_lance")
            .joinpath("studio_assets", filename)
            .read_bytes()
        )
        self._response(200, content, content_type)

    def _json_response(
        self,
        status: int,
        value: Mapping[str, Any],
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self._response(status, body, "application/json; charset=utf-8", extra_headers)

    def _response(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in _SECURITY_HEADERS.items():
            self.send_header(name, value)
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


def _newest_sort_key(row: Mapping[str, Any]) -> tuple[bool, int, str]:
    timestamp = row.get("event_time_ms")
    return (
        timestamp is None,
        -(int(timestamp) if timestamp is not None else 0),
        str(row["record_id"]),
    )


def _oldest_sort_key(row: Mapping[str, Any]) -> tuple[bool, int, str]:
    timestamp = row.get("event_time_ms")
    return (
        timestamp is None,
        int(timestamp) if timestamp is not None else 0,
        str(row["record_id"]),
    )


def _record_summary(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "record_id": row["record_id"],
        "record_type": row["record_type"],
        "event_time_ms": row.get("event_time_ms"),
        "author": _bounded_text(row.get("author"), 256),
        "text_preview": _bounded_text(row.get("text"), 240),
        "parent_id": row.get("parent_id"),
        "thread_id": row.get("thread_id"),
        "has_attachments": bool(row.get("attachments_json")),
        "has_reactions": bool(row.get("reactions_json")),
    }


def _feed_summary(row: Mapping[str, Any]) -> dict[str, Any]:
    record_type = row["record_type"]
    event_time_ms = row.get("event_time_ms")
    return {
        "record_id": row["record_id"],
        # Keep the canonical names for existing callers while exposing the short
        # feed vocabulary used by the simplified client.
        "type": record_type,
        "time": event_time_ms,
        "record_type": record_type,
        "event_time_ms": event_time_ms,
        "author": _bounded_text(row.get("author"), 256),
        "text_preview": _bounded_text(row.get("text"), 240),
        "source_category": _bounded_text(row.get("source_category"), 128),
        "has_attachments": bool(row.get("attachments_json")),
        "has_reactions": bool(row.get("reactions_json")),
    }


def _chat_message_summary(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "record_id": row["record_id"],
        "event_time_ms": row.get("event_time_ms"),
        "author": _bounded_text(row.get("author"), 256),
        "text_preview": _bounded_text(row.get("text"), 240),
        "text": _bounded_text(row.get("text"), 65536),
        "has_attachments": bool(row.get("attachments_json")),
        "has_reactions": bool(row.get("reactions_json")),
    }


def _message_threads(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    threads: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        thread_id = row.get("thread_id")
        if row.get("record_type") != "message" or not isinstance(thread_id, str):
            continue
        if not _RECORD_ID.fullmatch(thread_id):
            continue
        threads.setdefault(thread_id, []).append(row)
    return threads


def _thread_display_label(thread_id: str, messages: list[dict[str, Any]]) -> str:
    authors: Counter[str] = Counter()
    spellings: dict[str, str] = {}
    for message in messages:
        author = message.get("author")
        if not isinstance(author, str):
            continue
        cleaned = " ".join(author.split())
        if not cleaned:
            continue
        identity = cleaned.casefold()
        authors[identity] += 1
        spellings.setdefault(identity, cleaned)

    ranked = sorted(authors, key=lambda item: (-authors[item], item))
    top = [_bounded_text(spellings[item], 72) for item in ranked[:3]]
    if not top:
        return f"Conversation {thread_id[:10]}"
    label = " · ".join(top)
    if len(ranked) > len(top):
        label += f" +{len(ranked) - len(top)}"
    return _bounded_text(label, 256)


def _thread_newest_sort_key(thread: Mapping[str, Any]) -> tuple[bool, int, str]:
    timestamp = thread.get("latest_time_ms")
    return (
        timestamp is None,
        -(int(timestamp) if timestamp is not None else 0),
        str(thread["thread_id"]),
    )


def _thread_oldest_sort_key(thread: Mapping[str, Any]) -> tuple[bool, int, str]:
    timestamp = thread.get("latest_time_ms")
    return (
        timestamp is None,
        int(timestamp) if timestamp is not None else 0,
        str(thread["thread_id"]),
    )


def _query_and_limit(
    request: Mapping[str, Any], *, allow_query: bool = True
) -> tuple[str, int]:
    query = request.get("query", "") if allow_query else ""
    if not isinstance(query, str) or len(query) > _MAX_QUERY_CHARS:
        raise _BadRequest
    limit = request.get("limit", 50)
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= _MAX_LIMIT
    ):
        raise _BadRequest
    return query.casefold().strip(), limit


def _request_offset(cursor: Any, fingerprint: str, secret: bytes) -> int:
    return 0 if cursor is None else _decode_cursor(cursor, fingerprint, secret)


def _page_response(
    rows: list[dict[str, Any]],
    offset: int,
    limit: int,
    fingerprint: str,
    secret: bytes,
    summarize: Any,
) -> dict[str, Any]:
    page = rows[offset : offset + limit]
    next_offset = offset + len(page)
    next_cursor = (
        _encode_cursor(next_offset, fingerprint, secret)
        if next_offset < len(rows)
        else None
    )
    return {
        "items": [summarize(row) for row in page],
        "matched_count": len(rows),
        "next_cursor": next_cursor,
        "has_more": next_cursor is not None,
    }


def _bounded_record(row: Mapping[str, Any]) -> dict[str, Any]:
    bounded: dict[str, Any] = {}
    for key, value in row.items():
        bounded[key] = _bounded_text(value, 65536) if isinstance(value, str) else value
    return bounded


def _bounded_text(value: Any, maximum: int) -> Any:
    if not isinstance(value, str) or len(value) <= maximum:
        return value
    return value[: maximum - 1] + "…"


def _cursor_fingerprint(route: str, *components: Any) -> str:
    canonical = json.dumps([route, *components], separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()[:16]


def _encode_cursor(offset: int, fingerprint: str, secret: bytes) -> str:
    payload = struct.pack(">Q", offset) + fingerprint.encode("ascii")
    signature = hmac.digest(secret, payload, "sha256")[:16]
    return base64.urlsafe_b64encode(payload + signature).rstrip(b"=").decode()


def _decode_cursor(cursor: Any, fingerprint: str, secret: bytes) -> int:
    if not isinstance(cursor, str) or not 1 <= len(cursor) <= 128:
        raise _BadRequest
    try:
        padding = "=" * (-len(cursor) % 4)
        value = base64.b64decode(cursor + padding, altchars=b"-_", validate=True)
    except ValueError as error:
        raise _BadRequest from error
    if len(value) != 40:
        raise _BadRequest
    payload, signature = value[:24], value[24:]
    expected_signature = hmac.digest(secret, payload, "sha256")[:16]
    if not hmac.compare_digest(signature, expected_signature):
        raise _BadRequest
    offset = struct.unpack(">Q", payload[:8])[0]
    if payload[8:] != fingerprint.encode("ascii") or offset > 10_000_000:
        raise _BadRequest
    return offset
