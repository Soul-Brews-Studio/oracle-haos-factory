from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import service


class RuntimeConfigTests(unittest.TestCase):
    def test_options_supply_remote_embedder_without_leaking_into_argv(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            options = Path(temporary) / "options.json"
            options.write_text(
                json.dumps(
                    {
                        "embed_url": "http://100.64.0.10:8792",
                        "embed_token": "private-value",
                        "embed_timeout_seconds": 18,
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"OPTIONS_PATH": str(options), "LANCE_DB": "/private/archive"},
                clear=True,
            ):
                database, url, token, timeout = service.runtime_config()
            self.assertEqual(database, "/private/archive")
            self.assertEqual(url, "http://100.64.0.10:8792")
            self.assertEqual(token, "private-value")
            self.assertEqual(timeout, 18)

    def test_url_and_token_must_be_configured_together(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            options = Path(temporary) / "options.json"
            options.write_text('{"embed_url":"http://embedder"}', encoding="utf-8")
            with (
                patch.dict(os.environ, {"OPTIONS_PATH": str(options)}, clear=True),
                self.assertRaisesRegex(ValueError, "configured together"),
            ):
                service.runtime_config()

    def test_environment_overrides_supervisor_options(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            options = Path(temporary) / "options.json"
            options.write_text(
                '{"embed_url":"http://old","embed_token":"old"}', encoding="utf-8"
            )
            environment = {
                "OPTIONS_PATH": str(options),
                "FACEBOOK_LANCE_EMBED_URL": "https://new.example",
                "FACEBOOK_LANCE_EMBED_TOKEN": "new-token",
                "FACEBOOK_LANCE_EMBED_TIMEOUT": "9",
            }
            with patch.dict(os.environ, environment, clear=True):
                _, url, token, timeout = service.runtime_config()
            self.assertEqual((url, token, timeout), ("https://new.example", "new-token", 9))


class PackagingContractTests(unittest.TestCase):
    def test_no_private_or_model_artifacts_are_packaged(self) -> None:
        root = Path(__file__).resolve().parent
        forbidden = {
            ".zip",
            ".onnx",
            ".safetensors",
            ".lance",
            ".lancedb",
            ".token",
            ".secret",
        }
        offenders = [
            path
            for path in root.rglob("*")
            if path.is_file()
            and (path.suffix in forbidden or path.name == "tokenizer.json")
        ]
        self.assertEqual(offenders, [])

    def test_mutations_remain_blocked(self) -> None:
        source = Path(service.__file__).read_text(encoding="utf-8")
        self.assertIn("def do_PUT", source)
        self.assertIn("do_PATCH = do_PUT", source)
        self.assertIn("do_DELETE = do_PUT", source)
        self.assertIn("MAX_REQUEST_BYTES = 4096", source)

    def test_compat_runtime_and_no_onnx_dependency(self) -> None:
        root = Path(__file__).resolve().parent
        requirements = (root / "requirements.txt").read_text(encoding="utf-8")
        dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("lancedb-compat==0.38.0", requirements)
        self.assertIn("pythainlp==5.3.7", requirements)
        self.assertIn("tokenizers==0.23.1", requirements)
        self.assertNotIn("onnxruntime", requirements)
        self.assertIn("python:3.12-slim-bookworm", dockerfile)
        self.assertNotIn("import lance\n", dockerfile)
        self.assertIn("from lancedb.pydantic import LanceModel, Vector", dockerfile)
        self.assertIn("_VectorProbe.to_arrow_schema()", dockerfile)

    def test_current_hybrid_and_generation_runtime_is_vendored(self) -> None:
        package = Path(__file__).resolve().parent / "app" / "facebook_lance"
        derived = (package / "derived_state.py").read_text(encoding="utf-8")
        semantic = (package / "semantic.py").read_text(encoding="utf-8")
        server = (package / "server.py").read_text(encoding="utf-8")
        self.assertIn("semantic_write_lock", derived)
        self.assertIn("semantic-generation.json", derived)
        self.assertIn("build_semantic_index", semantic)
        self.assertIn("build_topics", semantic)
        self.assertIn("search_text_ngrams", semantic)
        self.assertIn("lexical_text_words", semantic)
        self.assertIn("MatchQuery", semantic)
        self.assertIn('"/api/search/semantic"', server)
        self.assertIn('"lexical_ready"', server)


class _StudioFixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        _ = format, args

    def do_GET(self) -> None:
        if self.path == "/":
            body = b'<link href="/studio.css"><script src="/studio.js"></script>'
            content_type = "text/html; charset=utf-8"
        elif self.path == "/studio.js":
            body = b'fetch("/api/status")'
            content_type = "text/javascript; charset=utf-8"
        else:
            body = b'{"ready":true}'
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.studio = ThreadingHTTPServer(("127.0.0.1", 0), _StudioFixtureHandler)
        self.studio_thread = threading.Thread(
            target=self.studio.serve_forever, daemon=True
        )
        self.studio_thread.start()
        self.proxy = service.ProxyServer(0, self.studio.server_address[1])
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()

    def tearDown(self) -> None:
        self.proxy.shutdown()
        self.proxy.server_close()
        self.studio.shutdown()
        self.studio.server_close()

    def request(self, path: str, method: str = "GET"):
        connection = HTTPConnection("127.0.0.1", self.proxy.server_address[1], timeout=2)
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, headers, body

    def test_proxy_rewrites_root_relative_assets_for_ingress(self) -> None:
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b'href="./studio.css"', body)
        self.assertIn(b'src="./studio.js"', body)
        self.assertEqual(headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("frame-ancestors 'self'", headers["Content-Security-Policy"])

    def test_proxy_rewrites_api_calls_and_blocks_mutations(self) -> None:
        status, _, body = self.request("/studio.js")
        self.assertEqual(status, 200)
        self.assertIn(b'fetch("api/status")', body)
        status, headers, _ = self.request("/api/record", "DELETE")
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET, POST")

    def test_proxy_rejects_chunked_request_bodies(self) -> None:
        connection = HTTPConnection(
            "127.0.0.1", self.proxy.server_address[1], timeout=2
        )
        connection.request(
            "POST", "/api/records/query", body=[b"{}"], encode_chunked=True
        )
        response = connection.getresponse()
        response.read()
        connection.close()
        self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
