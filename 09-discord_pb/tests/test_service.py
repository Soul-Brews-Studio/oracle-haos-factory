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
                     {"auto_login_ha_admins": "true"},
                     {"admin_email": "user@example.test"}, {"channels": []}):
            with self.subTest(data=data), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "options.json"
                path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    service.options(path)

    def test_missing_options_does_not_silently_idle(self):
        with self.assertRaises(FileNotFoundError):
            service.options("/absent-discord-pb-test-options.json")
