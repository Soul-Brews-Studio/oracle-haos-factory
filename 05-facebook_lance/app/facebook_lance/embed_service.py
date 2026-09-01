"""Hardened stdlib HTTP service for the reusable embedding provider boundary."""

from __future__ import annotations

import hmac
import json
import os
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import urlsplit

from .embeddings import (
    VECTOR_DIMENSION,
    EmbeddingProvider,
    EmbeddingUnavailable,
    InvalidEmbeddingRequest,
    validate_vectors,
)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8792
TOKEN_ENVIRONMENT_VARIABLE = "FACEBOOK_LANCE_EMBED_TOKEN"
MAX_BODY_BYTES = 256 * 1024
MAX_BATCH_SIZE = 32
MAX_TEXT_CHARS = 8_000
MAX_TOTAL_TEXT_CHARS = 32_000

_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


class _BadRequest(Exception):
    """A request rejected without retaining or exposing its private text."""


class EmbeddingServer(ThreadingHTTPServer):
    """Threaded server carrying the provider and token only in process memory."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        provider: EmbeddingProvider,
        bearer_token: str,
        host: str,
        port: int,
    ) -> None:
        self.embedding_provider = provider
        self.provider_ready = True
        self.bearer_token = bearer_token
        super().__init__((host, port), EmbeddingRequestHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # The stdlib default prints exception details, which can contain request data.
        _ = request, client_address


def create_embedding_server(
    provider: EmbeddingProvider,
    *,
    bearer_token: str | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> EmbeddingServer:
    """Create an authenticated server, reading its secret from environment by default."""

    token = (
        bearer_token
        if bearer_token is not None
        else os.environ.get(TOKEN_ENVIRONMENT_VARIABLE)
    )
    if not isinstance(token, str) or not token:
        raise ValueError(f"{TOKEN_ENVIRONMENT_VARIABLE} is required")
    if (
        not isinstance(host, str)
        or not host
        or any(character.isspace() for character in host)
    ):
        raise ValueError("host is invalid")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")
    vector_space_id = provider.vector_space_id
    if not isinstance(vector_space_id, str) or not vector_space_id:
        raise ValueError("provider vector_space_id is invalid")
    preflight = getattr(provider, "preflight", None)
    if not callable(preflight):
        raise TypeError("provider preflight is required")
    preflight()
    return EmbeddingServer(provider, token, host, port)


def serve_embeddings(
    provider: EmbeddingProvider,
    *,
    bearer_token: str | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> None:
    """Serve embeddings until interrupted without logging requests or vectors."""

    server = create_embedding_server(
        provider, bearer_token=bearer_token, host=host, port=port
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


class EmbeddingRequestHandler(BaseHTTPRequestHandler):
    """Closed JSON-only API for health and E5 embeddings."""

    protocol_version = "HTTP/1.1"

    @property
    def _embedding_server(self) -> EmbeddingServer:
        """Return the server state attached by ``EmbeddingServer``."""

        return cast(EmbeddingServer, self.server)

    def log_message(self, format: str, *args: Any) -> None:
        _ = format, args

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        _ = message, explain
        if code == 501:
            self._method_not_allowed()
        else:
            self._json_response(code, {"error": "request_rejected"})

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/health":
            self._json_response(
                200,
                {
                    "ready": self._embedding_server.provider_ready,
                    "dimension": VECTOR_DIMENSION,
                    "vector_space_id": (
                        self._embedding_server.embedding_provider.vector_space_id
                    ),
                },
            )
        else:
            self._json_response(404, {"error": "not_found"})

    def do_POST(self) -> None:
        self.close_connection = True
        if urlsplit(self.path).path != "/v1/embeddings":
            self._json_response(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json_response(
                401,
                {"error": "unauthorized"},
                {"WWW-Authenticate": "Bearer"},
            )
            return
        if self.headers.get("Origin") is not None:
            self._json_response(403, {"error": "origin_not_allowed"})
            return
        try:
            request = self._read_request()
            vectors = self._embedding_server.embedding_provider.embed(
                request["texts"], kind=request["kind"]
            )
            validated = validate_vectors(vectors, expected_count=len(request["texts"]))
            self._json_response(
                200,
                {
                    "count": len(validated),
                    "dimension": VECTOR_DIMENSION,
                    "vector_space_id": (
                        self._embedding_server.embedding_provider.vector_space_id
                    ),
                    "vectors": validated,
                },
            )
        except (_BadRequest, InvalidEmbeddingRequest):
            self._json_response(400, {"error": "invalid_request"})
        except EmbeddingUnavailable:
            self._json_response(503, {"error": "unavailable"})
        except Exception:  # noqa: BLE001 - never return runtime or request details
            self._json_response(503, {"error": "unavailable"})

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

    def _authorized(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not authorization.startswith(prefix):
            return False
        return hmac.compare_digest(
            authorization[len(prefix) :], self._embedding_server.bearer_token
        )

    def _read_request(self) -> dict[str, Any]:
        if self.headers.get("Transfer-Encoding"):
            raise _BadRequest
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise _BadRequest
        try:
            length = int(raw_length)
        except ValueError as error:
            raise _BadRequest from error
        if not 0 <= length <= MAX_BODY_BYTES:
            raise _BadRequest
        if self.headers.get_content_type() != "application/json":
            raise _BadRequest
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise _BadRequest from error
        return _validate_request(value)

    def _json_response(
        self,
        status: int,
        payload: Mapping[str, Any],
        headers: Mapping[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in _SECURITY_HEADERS.items():
            self.send_header(name, value)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def _validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"kind", "texts"}:
        raise _BadRequest
    kind = value["kind"]
    texts = value["texts"]
    if kind not in {"query", "document"}:
        raise _BadRequest
    if (
        not isinstance(texts, list)
        or not 1 <= len(texts) <= MAX_BATCH_SIZE
        or any(not isinstance(text, str) for text in texts)
        or any(not text or len(text) > MAX_TEXT_CHARS for text in texts)
        or sum(len(text) for text in texts) > MAX_TOTAL_TEXT_CHARS
    ):
        raise _BadRequest
    return {"kind": kind, "texts": texts}
