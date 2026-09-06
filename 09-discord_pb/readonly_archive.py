"""Open a consistent, private snapshot of a SQLite archive without opening the source.

The source database may be live in WAL mode.  This module only performs ordinary
filesystem reads against the source files; SQLite is pointed exclusively at a
temporary copy where it may safely recover the copied WAL.
"""

from __future__ import annotations

import hashlib
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class SnapshotError(RuntimeError):
    """Raised when a stable main/WAL pair cannot be copied."""


def _digest(path: Path) -> str | None:
    try:
        stream = path.open("rb")
    except FileNotFoundError:
        return None
    digest = hashlib.sha256()
    with stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_if_present(source: Path, destination: Path) -> bool:
    try:
        with source.open("rb") as src, destination.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
    except FileNotFoundError:
        return False
    return True


@contextmanager
def snapshot(path: str | Path, attempts: int = 3) -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection to a stable private copy of *path* and its WAL.

    A copy is accepted only when hashes of the source main database and WAL are
    unchanged across the copy and equal the hashes of the copied files.  Up to
    ``attempts`` bounded attempts are made.  The source is never passed to
    SQLite, and its ``-shm`` file is neither read nor copied.
    """

    source = Path(path)
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    if not source.is_file():
        raise SnapshotError(f"SQLite archive does not exist: {source}")

    wal = Path(f"{source}-wal")
    last_reason = "source changed while copying"
    with tempfile.TemporaryDirectory(prefix="discord-pb-archive-") as directory:
        root = Path(directory)
        private = root / "archive.sqlite"
        private_wal = Path(f"{private}-wal")

        for attempt in range(1, attempts + 1):
            before_main = _digest(source)
            before_wal = _digest(wal)
            if before_main is None:
                raise SnapshotError(f"SQLite archive disappeared: {source}")

            if not _copy_if_present(source, private):
                last_reason = "main database disappeared while copying"
                continue
            copied_main = _digest(private)

            wal_copied = _copy_if_present(wal, private_wal)
            if not wal_copied and private_wal.exists():
                private_wal.unlink()
            copied_wal = _digest(private_wal) if wal_copied else None

            after_main = _digest(source)
            after_wal = _digest(wal)
            stable = (
                before_main == after_main == copied_main
                and before_wal == after_wal == copied_wal
            )
            if not stable:
                last_reason = (
                    f"source main/WAL changed during attempt {attempt}"
                )
                continue

            connection: sqlite3.Connection | None = None
            try:
                connection = sqlite3.connect(private)
                # Forces WAL recovery and proves the private pair is readable.
                check = connection.execute("PRAGMA quick_check").fetchone()
                if check != ("ok",):
                    raise SnapshotError(f"private SQLite snapshot failed quick_check: {check!r}")
            except sqlite3.Error as error:
                if connection is not None:
                    connection.close()
                raise SnapshotError(f"cannot recover private SQLite snapshot: {error}") from error
            try:
                yield connection
            finally:
                connection.close()
            return

    raise SnapshotError(
        f"could not make a stable SQLite archive snapshot after {attempts} attempts: "
        f"{last_reason}"
    )
