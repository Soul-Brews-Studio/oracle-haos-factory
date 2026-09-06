import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("service", Path(__file__).parents[1] / "service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
    def test_invalid_options_fail_closed(self):
        for data in ([], {"poll_minutes": 0}, {"poll_minutes": True}, {"auto_login": "true"},
                     {"live": "true"}, {"auto_login_ha_admins": "true"}, {"allow_post": "true"}, {"post_channels": []},
                     {"admin_email": "user@example.test"}, {"channels": []}):
            with self.subTest(data=data), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "options.json"
                path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    service.options(path)

    def test_missing_options_does_not_silently_idle(self):
        with self.assertRaises(FileNotFoundError):
            service.options("/absent-discord-pb-test-options.json")

    def test_job_state_is_atomic_private_and_drops_old_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "job.json"
            service.write_job(path, "succeeded", "start")
            self.assertIn("finished_at", json.loads(path.read_text()))
            service.write_job(path, "running", "new-start")
            self.assertEqual(json.loads(path.read_text()),
                             {"state": "running", "started_at": "new-start"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(Path(str(path) + ".tmp").exists())
