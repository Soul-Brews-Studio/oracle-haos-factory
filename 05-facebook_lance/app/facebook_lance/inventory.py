"""Privacy-safe ZIP inventory based only on central-directory metadata."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

MEDIA_EXTENSIONS = {
    ".aac",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".m4a",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".png",
    ".wav",
    ".webm",
    ".webp",
}


@dataclass(frozen=True)
class Inventory:
    total_entries: int
    json_entries: int
    media_entries: int
    other_entries: int
    compressed_bytes: int
    uncompressed_bytes: int
    top_level_counts: dict[str, int]


def inventory_zip(path: Path) -> Inventory:
    """Return aggregate metadata without opening any archive member."""

    total_entries = 0
    json_entries = 0
    media_entries = 0
    compressed_bytes = 0
    uncompressed_bytes = 0
    top_level_counts: dict[str, int] = {}

    with ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            total_entries += 1
            compressed_bytes += info.compress_size
            uncompressed_bytes += info.file_size
            suffix = PurePosixPath(info.filename).suffix.lower()
            if suffix == ".json":
                json_entries += 1
            elif suffix in MEDIA_EXTENSIONS:
                media_entries += 1
            top_level = _top_level(info.filename)
            top_level_counts[top_level] = top_level_counts.get(top_level, 0) + 1

    return Inventory(
        total_entries=total_entries,
        json_entries=json_entries,
        media_entries=media_entries,
        other_entries=total_entries - json_entries - media_entries,
        compressed_bytes=compressed_bytes,
        uncompressed_bytes=uncompressed_bytes,
        top_level_counts=dict(sorted(top_level_counts.items())),
    )


def _top_level(member: str) -> str:
    parts = [part for part in PurePosixPath(member).parts if part not in {"", "."}]
    return parts[0] if parts else "(root)"
