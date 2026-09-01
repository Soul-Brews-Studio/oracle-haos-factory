"""Supervise loopback Studio and expose a small HA Ingress-safe proxy."""

from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.request import urlopen

MAX_REQUEST_BYTES = 4096
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)


def _option_values(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
        if len(raw) > 64 * 1024:
            raise ValueError("options file is too large")
        values = json.loads(raw)
    except FileNotFoundError:
        return {}
    if not isinstance(values, dict):
        raise TypeError("options must be an object")
    return values


def runtime_config() -> tuple[str, str, str, float]:
    values = _option_values(Path(os.environ.get("OPTIONS_PATH", "/data/options.json")))
    database = os.environ.get(
        "LANCE_DB", "/share/facebook-lance/facebook.lancedb"
    )
    embed_url = os.environ.get("FACEBOOK_LANCE_EMBED_URL")
    if embed_url is None:
        embed_url = values.get("embed_url") or ""
    embed_token = os.environ.get("FACEBOOK_LANCE_EMBED_TOKEN")
    if embed_token is None:
        embed_token = values.get("embed_token") or ""
    timeout_value = os.environ.get(
        "FACEBOOK_LANCE_EMBED_TIMEOUT", values.get("embed_timeout_seconds", 30)
    )
    timeout = float(timeout_value)
    if not 1 <= timeout <= 120:
        raise ValueError("embedding timeout is outside the supported range")
    if bool(embed_url) != bool(embed_token):
        raise ValueError("embedding URL and token must be configured together")
    if not isinstance(embed_url, str) or not isinstance(embed_token, str):
        raise TypeError("embedding configuration must be text")
    return database, embed_url, embed_token, timeout


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, studio_port: int) -> None:
        self.studio_port = studio_port
        super().__init__(("0.0.0.0", port), ProxyHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        _ = request, client_address


class ProxyHandler(BaseHTTPRequestHandler):
    server: ProxyServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Query text and record identifiers are private archive data.
        _ = format, args

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/health":
            self._health()
            return
        self._proxy()

    def do_POST(self) -> None:
        # Never leave an unread or malformed private request body on a reusable
        # connection where it could be interpreted as a second request.
        self.close_connection = True
        self._proxy()

    def do_PUT(self) -> None:
        self._method_not_allowed()

    do_PATCH = do_PUT
    do_DELETE = do_PUT

    def _health(self) -> None:
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", self.server.studio_port, timeout=2
            )
            connection.request("GET", "/api/status", headers={"Host": "localhost"})
            response = connection.getresponse()
            response.read(MAX_RESPONSE_BYTES)
            ready = response.status == 200
        except (OSError, http.client.HTTPException):
            ready = False
        finally:
            try:
                connection.close()
            except UnboundLocalError:
                pass
        self._json(200 if ready else 503, {"status": "ok" if ready else "starting", "read_only": True})

    def _proxy(self) -> None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._json(400, {"error": "request_rejected"})
            return
        length_header = self.headers.get("Content-Length", "0")
        if not length_header.isdigit() or int(length_header) > MAX_REQUEST_BYTES:
            self._json(413, {"error": "request_rejected"})
            return
        body = self.rfile.read(int(length_header)) if int(length_header) else None
        headers = {"Host": "localhost"}
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", self.server.studio_port, timeout=35
            )
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise OSError("response too large")
            content = response.getheader("Content-Type", "")
            if content.startswith("text/html"):
                payload = payload.replace(b'href="/studio.css"', b'href="./studio.css"')
                payload = payload.replace(b'src="/studio.js"', b'src="./studio.js"')
            elif content.startswith("text/javascript"):
                payload = payload.replace(b'"/api/', b'"api/')
                payload = payload.replace(b"'/api/", b"'api/")
            self.send_response(response.status)
            for name, value in response.getheaders():
                lower = name.casefold()
                if lower in HOP_HEADERS or lower in {
                    "content-length",
                    "content-security-policy",
                    "x-frame-options",
                }:
                    continue
                self.send_header(name, value)
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'none'; media-src 'none'; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; "
                "form-action 'none'",
            )
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (OSError, http.client.HTTPException):
            self._json(503, {"error": "unavailable"})
        finally:
            try:
                connection.close()
            except UnboundLocalError:
                pass

    def _method_not_allowed(self) -> None:
        self._json(405, {"error": "method_not_allowed"}, {"Allow": "GET, POST"})

    def _json(
        self, status: int, value: dict[str, Any], headers: dict[str, str] | None = None
    ) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        for name, header_value in (headers or {}).items():
            self.send_header(name, header_value)
        self.end_headers()
        self.wfile.write(payload)


def _wait_for_studio(process: subprocess.Popen[bytes], port: int) -> None:
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError("Studio exited before readiness")
        try:
            with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("Studio readiness timed out")


def main() -> int:
    database, embed_url, embed_token, embed_timeout = runtime_config()
    port = int(os.environ.get("PORT", "8104"))
    studio_port = int(os.environ.get("STUDIO_PORT", "8791"))
    app_dir = os.environ.get("APP_DIR", "/app")
    command = [
        sys.executable,
        "-m",
        "facebook_lance",
        "studio",
        "--db",
        database,
        "--port",
        str(studio_port),
        "--embed-timeout",
        str(embed_timeout),
    ]
    environment = os.environ.copy()
    if embed_url:
        command.extend(["--embed-url", embed_url])
        environment["FACEBOOK_LANCE_EMBED_TOKEN"] = embed_token
    process = subprocess.Popen(command, cwd=app_dir, env=environment)
    server: ProxyServer | None = None
    stopping = threading.Event()

    def stop(*_: Any) -> None:
        stopping.set()
        if server is not None:
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        _wait_for_studio(process, studio_port)
        if stopping.is_set():
            return 0
        server = ProxyServer(port, studio_port)

        def monitor() -> None:
            process.wait()
            if not stopping.is_set():
                server.shutdown()

        threading.Thread(target=monitor, daemon=True).start()
        print(f"Facebook Lance ready on port {port}; read-only Studio", flush=True)
        server.serve_forever()
    finally:
        if server is not None:
            server.server_close()
        unexpected_exit = process.poll() is not None and not stopping.is_set()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    return 1 if unexpected_exit else 0


def entrypoint() -> int:
    try:
        return main()
    except (OSError, TypeError, ValueError, RuntimeError):
        # Storage exceptions may include private paths or table metadata.
        print(
            "Facebook Lance could not start; check database and add-on options",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(entrypoint())
