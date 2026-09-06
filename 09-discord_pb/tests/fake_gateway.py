"""Tiny HTTP + WebSocket Discord Gateway fixture for protocol tests."""
import base64
import hashlib
import json
import socket
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _exact(stream, size):
    value = b""
    while len(value) < size:
        chunk = stream.recv(size - len(value))
        if not chunk:
            raise EOFError
        value += chunk
    return value


def recv_frame(stream):
    first, second = _exact(stream, 2)
    opcode, length = first & 15, second & 127
    if length == 126: length = struct.unpack("!H", _exact(stream, 2))[0]
    elif length == 127: length = struct.unpack("!Q", _exact(stream, 8))[0]
    mask = _exact(stream, 4) if second & 128 else None
    data = _exact(stream, length)
    if mask: data = bytes(v ^ mask[i % 4] for i, v in enumerate(data))
    return opcode, data


def send_frame(stream, opcode, data=b""):
    if isinstance(data, str): data = data.encode()
    length = len(data); head = bytearray([128 | opcode])
    if length < 126: head.append(length)
    elif length < 65536: head.append(126); head.extend(struct.pack("!H", length))
    else: head.append(127); head.extend(struct.pack("!Q", length))
    stream.sendall(head + data)


def send_json(stream, value):
    send_frame(stream, 1, json.dumps(value, separators=(",", ":")))


def recv_json(stream, timeout=2):
    stream.settimeout(timeout)
    while True:
        opcode, data = recv_frame(stream)
        if opcode == 1: return json.loads(data)
        if opcode == 9: send_frame(stream, 10, data)


class FakeGateway:
    def __init__(self, scripts, limits=None):
        self.scripts = list(scripts)
        self.received = []
        self.errors = []
        self.limits = list(limits or [{"remaining": 1000, "reset_after": 0, "max_concurrency": 1}])
        self.gateway_requests = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_GET(self):
                if self.path == "/api/v10/gateway/bot":
                    fixture.gateway_requests += 1
                    limit = fixture.limits.pop(0) if len(fixture.limits) > 1 else fixture.limits[0]
                    body = json.dumps({"url": fixture.ws_url, "session_start_limit": limit}).encode()
                    self.send_response(200); self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                    return
                if not self.path.startswith("/gateway"):
                    self.send_error(404); return
                key = self.headers.get("Sec-WebSocket-Key", "")
                accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response(101); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept); self.end_headers()
                try:
                    script = fixture.scripts.pop(0)
                except IndexError:
                    send_frame(self.connection, 8, struct.pack("!H", 4000)); return
                try: script(fixture, self.connection)
                except (EOFError, OSError, socket.timeout): pass
                except BaseException as error: fixture.errors.append(error)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def api_url(self):
        return f"http://127.0.0.1:{self.server.server_port}/api/v10"

    @property
    def ws_url(self):
        return f"ws://127.0.0.1:{self.server.server_port}/gateway"

    def start(self): self.thread.start(); return self
    def close(self): self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
    def __enter__(self): return self.start()
    def __exit__(self, *_): self.close()


def hello(stream, interval=50):
    send_json(stream, {"op": 10, "d": {"heartbeat_interval": interval}})


def receive_until(stream, wanted, fixture, timeout=2):
    while True:
        value = recv_json(stream, timeout)
        fixture.received.append(value)
        if value.get("op") == 1:
            send_json(stream, {"op": 11, "d": None})
        if value.get("op") == wanted:
            return value
