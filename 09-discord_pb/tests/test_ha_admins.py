import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ha_admins  # noqa: E402


class AdminIdsTest(unittest.TestCase):
    def test_owner_and_admin_group_only(self):
        users = [
            {"id": "owner1", "is_owner": True, "is_active": True, "group_ids": ["system-users"]},
            {"id": "admin1", "is_owner": False, "is_active": True, "group_ids": ["system-admin"]},
            {"id": "user1", "is_owner": False, "is_active": True, "group_ids": ["system-users"]},
            {"id": "gone1", "is_owner": False, "is_active": False, "group_ids": ["system-admin"]},
            {"id": "sys1", "system_generated": True, "is_active": True, "group_ids": ["system-admin"]},
            {"id": "", "is_owner": True},
            "garbage",
        ]
        self.assertEqual(ha_admins.admin_ids(users), ["admin1", "owner1"])

    def test_rejects_non_list(self):
        with self.assertRaises(ValueError):
            ha_admins.admin_ids({"id": "x"})

    def test_write_atomic_private(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "run" / "ha-admins.json"
            ha_admins.write_atomic(target, {"at": "2026-09-07T00:00:00+00:00", "admins": ["a"]})
            self.assertEqual(json.loads(target.read_text()), {"admins": ["a"], "at": "2026-09-07T00:00:00+00:00"})
            self.assertEqual(oct(target.stat().st_mode & 0o777), oct(0o600))
            self.assertEqual([p.name for p in target.parent.iterdir()], ["ha-admins.json"])


if __name__ == "__main__":
    unittest.main()
