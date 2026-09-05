"""Focused HTTP contract tests for the HAOS add-on copy."""

from __future__ import annotations

import http.client
import json
import re
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from app import Handler


class AddonServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        Handler.db_path = Path(self.temporary.name) / "line.lance"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request_raw(self, method: str, path: str) -> tuple[int, bytes, dict[str, str]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, body, headers

    def request(self, method: str, path: str) -> tuple[int, dict[str, object], dict[str, str]]:
        status, body, headers = self.request_raw(method, path)
        return status, json.loads(body), headers

    def test_prebuilt_frontend_is_served_on_the_direct_port(self) -> None:
        status, body, headers = self.request_raw("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b'<div id="root"></div>', body)
        assets = re.findall(rb'(?:src|href)="([^\"]+\.(?:js|css))"', body)
        self.assertGreaterEqual(len(assets), 2)
        for asset in assets:
            path = "/" + asset.decode().removeprefix("./").lstrip("/")
            with self.subTest(asset=path):
                asset_status, asset_body, _asset_headers = self.request_raw("GET", path)
                self.assertEqual(asset_status, 200)
                self.assertTrue(asset_body)

    def test_health_reports_addon_identity_and_empty_archive(self) -> None:
        status, payload, _headers = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["slug"], "line_lance")
        self.assertEqual(payload["version"], "0.3.0")
        self.assertEqual(payload["messages"], 0)

    def test_empty_stats_and_tables_remain_valid(self) -> None:
        stats_status, stats, _headers = self.request("GET", "/api/stats")
        self.assertEqual(stats_status, 200)
        self.assertEqual(stats["messages"], 0)
        self.assertEqual(stats["chats"], 0)

        tables_status, tables, _headers = self.request("GET", "/api/tables")
        self.assertEqual(tables_status, 200)
        self.assertEqual(tables["tables"], [])
        self.assertEqual(tables["db_path"], str(Handler.db_path))

    def test_write_methods_are_refused(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                status, payload, headers = self.request(method, "/api/messages")
                self.assertEqual(status, 405)
                self.assertEqual(payload, {"error": "method not allowed"})
                self.assertEqual(headers["Allow"], "GET")


if __name__ == "__main__":
    unittest.main()
