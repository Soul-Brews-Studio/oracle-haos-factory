import hashlib
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


import sys
sys.path.insert(0, str(ROOT))
archive = load("readonly_archive", "readonly_archive.py")
verify = load("discord_pb_verify", "verify.py")


def digest(path):
    path = Path(path)
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


class ArchiveSnapshotTests(unittest.TestCase):
    def test_active_wal_committed_row_is_counted_without_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "messages.sqlite"
            writer = sqlite3.connect(db)
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE discord_messages (message_id TEXT, channel_id TEXT, thread_id TEXT)")
            writer.commit()
            writer.execute("INSERT INTO discord_messages VALUES ('1', '12345678901234567', NULL)")
            writer.commit()
            paths = [db, Path(f"{db}-wal"), Path(f"{db}-shm")]
            before = [digest(path) for path in paths]

            with archive.snapshot(db) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM discord_messages").fetchone()[0], 1)

            after = [digest(path) for path in paths]
            self.assertEqual(before, after)
            writer.close()

    def test_unstable_copy_retries_only_three_times_and_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "messages.sqlite"
            sqlite3.connect(db).close()
            with patch.object(archive, "_digest", side_effect=["a", None, "a", "b", None] * 3) as hashed:
                with self.assertRaisesRegex(archive.SnapshotError, "after 3 attempts"):
                    with archive.snapshot(db):
                        pass
            self.assertEqual(hashed.call_count, 15)


class VerifyTests(unittest.TestCase):
    def source(self, rows):
        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE discord_messages (channel_id TEXT, thread_id TEXT)")
        connection.executemany("INSERT INTO discord_messages VALUES (?, ?)", rows)
        return connection

    @contextmanager
    def fake_snapshot(self, connection):
        yield connection

    def test_parent_and_thread_rows_group_by_parent_channel_only(self):
        channel = "12345678901234567"
        connection = self.source([(channel, None), (channel, "22345678901234567")])
        self.assertEqual(verify.archive_counts(connection), {channel: 2})
        connection.close()

    def test_mismatch_prints_total_and_returns_nonzero(self):
        channel = "12345678901234567"
        connection = self.source([(channel, None), (channel, None)])
        status = {"ok": True, "total": 1, "channels": [{"channel_id": channel, "count": 1}]}
        with patch.object(verify, "fetch_status", return_value=status), patch.object(
            verify, "snapshot", side_effect=lambda path: self.fake_snapshot(connection)
        ), patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(verify.verify("unused", "http://pb", channel), 1)
        self.assertEqual(output.getvalue().splitlines()[-1], "TOTAL 2 1 MISMATCH")
        connection.close()

    def test_malformed_status_never_becomes_zero(self):
        malformed = [
            {},
            {"ok": True, "total": 0, "channels": "bad"},
            {"ok": True, "total": 2, "channels": [{"channel_id": "12345678901234567", "count": 1}]},
            {"ok": True, "total": 1, "channels": [{"channel_id": "12345678901234567", "count": True}]},
        ]
        for payload in malformed:
            with self.subTest(payload=payload), self.assertRaises(verify.VerificationError):
                verify.status_counts(payload)

    def test_selection_rejects_empty_duplicates_injection_and_unknown(self):
        known = {"12345678901234567": 1}
        bad = ["", "12345678901234567,12345678901234567", "12345678901234567 OR 1=1", "22345678901234567"]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(verify.VerificationError):
                verify.selected_channels(raw, known, known)

    def test_fetch_status_uses_timeout(self):
        response = io.BytesIO(json.dumps({"ok": True}).encode())
        response.__enter__ = lambda value: value
        response.__exit__ = lambda *args: None
        with patch.object(verify, "urlopen", return_value=response) as opened:
            verify.fetch_status("http://pb/", 2.5)
        opened.assert_called_once_with("http://pb/api/discord/status", timeout=2.5)


if __name__ == "__main__":
    unittest.main()
