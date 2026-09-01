"""Small stdlib-only coordination primitives for rebuildable derived data."""

from __future__ import annotations

import fcntl
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SEMANTIC_BUILD_LOCK = ".facebook-lance-semantic.lock"
SEMANTIC_GENERATION_MANIFEST = "semantic-generation.json"


@contextmanager
def semantic_write_lock(db_uri: str | Path) -> Iterator[None]:
    """Serialize writers with a crash-safe advisory lock on a persistent file."""

    root = _local_db_root(db_uri)
    path = root / SEMANTIC_BUILD_LOCK
    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise RuntimeError("semantic build lock path is invalid") from error
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError("semantic build lock path is invalid")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                "another semantic or import build is running"
            ) from None
        current = path.lstat()
        if (
            not stat.S_ISREG(current.st_mode)
            or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            raise RuntimeError("semantic build lock path is invalid")
        os.ftruncate(descriptor, 0)
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        os.fsync(descriptor)
        try:
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def invalidate_semantic_generation(db_uri: str | Path) -> None:
    """Hide all derived tables before mutating their canonical source."""

    root = _local_db_root(db_uri)
    path = root / SEMANTIC_GENERATION_MANIFEST
    try:
        path.lstat()
    except FileNotFoundError:
        return
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("semantic generation manifest path is invalid")
    path.unlink()
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _local_db_root(db_uri: str | Path) -> Path:
    uri = str(db_uri)
    if "://" in uri:
        raise ValueError("semantic coordination requires a local database")
    root = Path(uri).resolve(strict=True)
    if not root.is_dir():
        raise FileNotFoundError(uri)
    return root
