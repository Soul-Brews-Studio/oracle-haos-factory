"""Container integration tests for the hybrid entrypoint and build."""
from __future__ import annotations
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

class EntrypointTests(unittest.TestCase):
    def test_dry_run_preserves_archive_and_resolves_both_services(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "share" / "line-lance" / "line.lance"
            database.mkdir(parents=True)
            marker = database / "marker"
            marker.write_text("persistent", encoding="utf-8")
            environment = {**os.environ, "APP_DIR": str(HERE),
                "GATEWAY_DIR": str(HERE / "gateway"), "LANCE_DB": str(database),
                "PYTHON_BIN": "/custom/python", "NODE_BIN": "/custom/node",
                "PORT": "8103", "ARCHIVE_PORT": "4133", "DRY_RUN": "1"}
            result = subprocess.run([str(HERE / "run.sh")], env=environment,
                check=True, capture_output=True, text=True)
            self.assertEqual(marker.read_text(encoding="utf-8"), "persistent")
            self.assertIn("umask=077", result.stdout)
            self.assertIn(f"--db {database}", result.stdout)
            self.assertIn("--host 127.0.0.1 --port 4133", result.stdout)
            self.assertIn("HOST=0.0.0.0 PORT=8103", result.stdout)
            self.assertIn("ARCHIVE_ORIGIN=http://127.0.0.1:4133", result.stdout)
            self.assertIn("/custom/node", result.stdout)

    def test_entrypoint_has_readiness_and_process_supervision(self) -> None:
        script = (HERE / "run.sh").read_text(encoding="utf-8")
        self.assertIn("/api/health", script)
        self.assertIn("trap cleanup INT TERM EXIT", script)
        self.assertIn('kill -0 "${archive_pid}"', script)
        self.assertIn('kill -0 "${gateway_pid}"', script)

    def test_dockerfile_builds_node_24_gateway_and_frontend(self) -> None:
        dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8")
        self.assertGreaterEqual(dockerfile.count("FROM node:24-bookworm-slim"), 2)
        self.assertIn("npm run typecheck && npm run build", dockerfile)
        self.assertIn("npm run typecheck && npm test", dockerfile)
        self.assertIn("/app/gateway/dist", dockerfile)
        self.assertIn("/app/frontend/dist", dockerfile)
        self.assertIn("APP_VERSION=0.3.0", dockerfile)
        self.assertIn("libatomic1 libstdc++6", dockerfile)
        self.assertIn("node --version", dockerfile)

if __name__ == "__main__":
    unittest.main()
