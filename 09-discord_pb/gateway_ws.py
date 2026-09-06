#!/usr/bin/env python3
"""Small RFC 6455 client for Discord Gateway JSON frames (stdlib only)."""
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
from urllib.parse import urlparse


class WebSocketError(RuntimeError):
    pass


class WebSocketClosed(WebSocketError):
    def __init__(self, code=1006, reason=""):
        super().__init__(f"websocket closed ({code})")
        self.code = code
        self.reason = reason


def _read_exact(stream, size, idle=False):
    chunks = []
    remaining = size
    while remaining:
        try:
            chunk = stream.recv(remaining)
        except socket.timeout as error:
            if idle and not chunks:
                raise
            raise WebSocketError("WebSocket frame timed out") from error
        if not chunk:
            raise WebSocketClosed()
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class WebSocket:
    """One blocking WebSocket connection with masked client frames."""

    def __init__(self, stream, timeout=30):
        self.stream = stream
        self.timeout = timeout
        self._fragments = bytearray()
        self._fragment_opcode = None
        self._send_lock = threading.Lock()

    @classmethod
    def connect(cls, url, timeout=30):
        parsed = urlparse(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise WebSocketError("invalid WebSocket URL")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        stream = socket.create_connection((parsed.hostname, port), timeout=timeout)
        try:
            if parsed.scheme == "wss":
                stream = ssl.create_default_context().wrap_socket(stream, server_hostname=parsed.hostname)
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            host = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{parsed.port}"
            request = (f"GET {target} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
                       f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                       "Sec-WebSocket-Version: 13\r\nUser-Agent: discord-pb/0.1.8\r\n\r\n")
            stream.sendall(request.encode("ascii"))
            response = bytearray()
            while b"\r\n\r\n" not in response:
                if len(response) > 16384:
                    raise WebSocketError("oversized WebSocket handshake")
                response.extend(_read_exact(stream, 1))
            head = response.decode("iso-8859-1").split("\r\n")
            parts = head[0].split(" ", 2)
            if len(parts) < 2 or not parts[0].startswith("HTTP/1.") or parts[1] != "101":
                raise WebSocketError("WebSocket upgrade rejected")
            headers = {}
            for line in head[1:]:
                if ":" in line:
                    name, value = line.split(":", 1)
                    headers[name.strip().lower()] = value.strip()
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if headers.get("sec-websocket-accept") != expected:
                raise WebSocketError("invalid WebSocket accept key")
            return cls(stream, timeout)
        except Exception:
            stream.close()
            raise

    def settimeout(self, timeout):
        self.stream.settimeout(timeout)

    def send_frame(self, opcode, payload=b""):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126); header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127); header.extend(struct.pack("!Q", length))
        header.extend(mask)
        header.extend(value ^ mask[index % 4] for index, value in enumerate(payload))
        with self._send_lock:
            self.stream.sendall(header)

    def send_json(self, value):
        self.send_frame(1, json.dumps(value, separators=(",", ":")))

    def recv_frame(self):
        first, second = _read_exact(self.stream, 2, idle=True)
        final, opcode = bool(first & 0x80), first & 0x0f
        masked, length = bool(second & 0x80), second & 0x7f
        if length == 126:
            length = struct.unpack("!H", _read_exact(self.stream, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", _read_exact(self.stream, 8))[0]
        if length > 16 * 1024 * 1024:
            raise WebSocketError("oversized WebSocket frame")
        mask = _read_exact(self.stream, 4) if masked else None
        payload = _read_exact(self.stream, length)
        if mask:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        return final, opcode, payload

    def recv_json(self):
        while True:
            final, opcode, payload = self.recv_frame()
            if opcode == 8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1000
                reason = payload[2:].decode("utf-8", errors="replace")[:200]
                raise WebSocketClosed(code, reason)
            if opcode == 9:
                self.send_frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode in {1, 2}:
                if self._fragment_opcode is not None:
                    raise WebSocketError("unexpected data frame")
                if final:
                    return json.loads(payload.decode("utf-8"))
                self._fragment_opcode = opcode
                self._fragments.extend(payload)
                continue
            if opcode == 0:
                if self._fragment_opcode is None:
                    raise WebSocketError("unexpected continuation frame")
                self._fragments.extend(payload)
                if len(self._fragments) > 16 * 1024 * 1024:
                    raise WebSocketError("oversized fragmented WebSocket message")
                if final:
                    assembled = bytes(self._fragments)
                    self._fragments.clear(); self._fragment_opcode = None
                    return json.loads(assembled.decode("utf-8"))
                continue
            raise WebSocketError("unsupported WebSocket opcode")

    def close(self, code=1000):
        try:
            self.send_frame(8, struct.pack("!H", code))
        except OSError:
            pass
        self.stream.close()

    def abort(self):
        """Close transport without a 1000 frame so Discord keeps the session resumable."""
        try: self.stream.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        self.stream.close()
