"""Read-only normalization of selected Facebook JSON export members."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import ZipFile, ZipInfo

from .schema import SCHEMA_VERSION, TEXT_TRANSFORM_VERSION

DEFAULT_CATEGORIES = frozenset(
    {"messages", "posts", "comments_and_reactions", "groups", "events"}
)

_ATTACHMENT_KEYS = (
    "photos",
    "videos",
    "files",
    "audio_files",
    "sticker",
    "share",
    "call_duration",
    "attachments",
    "media",
)
_TEXT_KEYS = (
    "content",
    "text",
    "message",
    "post",
    "comment",
    "title",
    "description",
    "name",
)
_AUTHOR_KEYS = ("sender_name", "author", "name", "actor")
_TIMESTAMP_KEYS = (
    "timestamp_ms",
    "timestamp",
    "start_timestamp",
    "creation_timestamp",
)


def fix_mojibake(value: object) -> object:
    """Repair Facebook's common UTF-8-as-Latin-1 encoding recursively."""

    if isinstance(value, str):
        try:
            return value.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return value
    if isinstance(value, list):
        return [fix_mojibake(item) for item in value]
    if isinstance(value, tuple):
        return tuple(fix_mojibake(item) for item in value)
    if isinstance(value, dict):
        return {
            str(fix_mojibake(key)): fix_mojibake(item) for key, item in value.items()
        }
    return value


def make_record_id(*parts: object, **named_parts: object) -> str:
    """Build a stable SHA-256 ID from canonical JSON-compatible values."""

    basis = {"parts": list(parts), "named": named_parts}
    return hashlib.sha256(_canonical_json(basis).encode("utf-8")).hexdigest()


def iter_normalized_records(
    zip_path: Path, categories: set[str] | None = None
) -> Iterator[dict[str, Any]]:
    """Yield selected normalized atoms without extracting the archive.

    JSON is retained for only one open archive member at a time. Media members are
    never opened. The default allowlist intentionally omits sensitive categories.
    """

    selected = DEFAULT_CATEGORIES if categories is None else frozenset(categories)
    if not selected:
        return

    with ZipFile(zip_path) as archive:
        json_members = sorted(
            (
                info
                for info in archive.infolist()
                if not info.is_dir() and info.filename.lower().endswith(".json")
            ),
            key=lambda info: info.filename,
        )
        export_id = _derive_export_id(zip_path, json_members)
        for info in json_members:
            category = _member_category(info.filename)
            if category not in selected:
                continue
            with archive.open(info, "r") as member:
                document = json.load(member)
            try:
                if category == "messages":
                    yield from _normalize_messages(
                        document, category, info.filename, export_id
                    )
                else:
                    yield from _normalize_activity(
                        document, category, info.filename, export_id
                    )
            finally:
                del document


def _derive_export_id(zip_path: Path, json_members: Sequence[ZipInfo]) -> str:
    metadata = {
        "archive_size": zip_path.stat().st_size,
        "json_members": [
            {"name": info.filename, "crc": info.CRC, "size": info.file_size}
            for info in json_members
        ],
    }
    return hashlib.sha256(_canonical_json(metadata).encode("utf-8")).hexdigest()


def _member_category(member: str) -> str | None:
    parts = PurePosixPath(member).parts
    for category in DEFAULT_CATEGORIES:
        if category in parts:
            return category
    return None


def _normalize_messages(
    document: object, category: str, member: str, export_id: str
) -> Iterator[dict[str, Any]]:
    if not isinstance(document, Mapping):
        return
    messages = document.get("messages")
    if not isinstance(messages, list):
        return

    raw_thread = document.get("thread_path") or member.rsplit("/", 1)[0]
    thread_id = make_record_id("thread", fix_mojibake(raw_thread))
    for ordinal, raw in enumerate(messages):
        if not isinstance(raw, Mapping):
            continue
        author = _first_string(raw, _AUTHOR_KEYS)
        text = _first_string(raw, ("content",))
        attachments = _pick_mapping_values(raw, _ATTACHMENT_KEYS)
        reactions = raw.get("reactions")
        raw_timestamp, unit, event_time_ms = _timestamp(raw)
        attachment_json = _optional_canonical_json(attachments)
        reactions_json = _optional_canonical_json(reactions)
        record_id = make_record_id(
            record_type="message",
            thread_id=thread_id,
            raw_timestamp=raw_timestamp,
            author=author,
            text=text,
            attachments=attachments,
        )
        yield _envelope(
            record_id=record_id,
            record_type="message",
            parent_id=thread_id,
            thread_id=thread_id,
            raw_timestamp=raw_timestamp,
            raw_timestamp_unit=unit,
            event_time_ms=event_time_ms,
            author=author,
            text=text,
            source_category=category,
            source_member=member,
            source_ordinal=ordinal,
            export_id=export_id,
            attachments_json=attachment_json,
            reactions_json=reactions_json,
        )


def _normalize_activity(
    document: object, category: str, member: str, export_id: str
) -> Iterator[dict[str, Any]]:
    for ordinal, (record_type, raw) in enumerate(
        _known_activity_rows(document, category)
    ):
        author = _first_string(raw, _AUTHOR_KEYS)
        text = _extract_text(raw)
        attachments = _pick_mapping_values(raw, _ATTACHMENT_KEYS)
        reactions = raw.get("reactions") or raw.get("reaction")
        raw_timestamp, unit, event_time_ms = _timestamp(raw)
        parent_value = raw.get("parent_id") or raw.get("post_id") or raw.get("fbid")
        parent_id = (
            make_record_id("parent", fix_mojibake(parent_value))
            if parent_value is not None
            else None
        )
        record_id = make_record_id(
            record_type=record_type,
            parent_id=parent_id,
            raw_timestamp=raw_timestamp,
            author=author,
            text=text,
            attachments=attachments,
            source_member=member,
            source_ordinal=ordinal,
        )
        yield _envelope(
            record_id=record_id,
            record_type=record_type,
            parent_id=parent_id,
            thread_id=None,
            raw_timestamp=raw_timestamp,
            raw_timestamp_unit=unit,
            event_time_ms=event_time_ms,
            author=author,
            text=text,
            source_category=category,
            source_member=member,
            source_ordinal=ordinal,
            export_id=export_id,
            attachments_json=_optional_canonical_json(attachments),
            reactions_json=_optional_canonical_json(reactions),
        )


def _known_activity_rows(
    document: object, category: str
) -> Iterator[tuple[str, Mapping[str, Any]]]:
    """Parse known Meta export shapes without harvesting arbitrary wrappers."""

    if category == "posts":
        rows = document if isinstance(document, list) else []
        for wrapper in rows:
            if isinstance(wrapper, Mapping):
                merged = _merge_data_item(wrapper, "post")
                if _first_string(merged, ("post", "title")) is not None:
                    yield "post", merged
        return

    if not isinstance(document, Mapping):
        return
    if category == "comments_and_reactions":
        for wrapper in _mapping_rows(document.get("comments_v2")):
            merged = _merge_data_item(wrapper, "comment")
            # Reaction-only rows have no comment text and are omitted in v1.
            if _first_string(merged, ("comment",)) is not None:
                yield "comment", merged
        return
    if category == "groups":
        for wrapper in _mapping_rows(document.get("group_posts_v2")):
            merged = _merge_data_item(wrapper, "post")
            if _first_string(merged, ("post",)) is not None:
                yield "group_post", merged
        for wrapper in _mapping_rows(document.get("group_comments_v2")):
            merged = _merge_data_item(wrapper, "comment")
            if _first_string(merged, ("comment",)) is not None:
                yield "group_comment", merged
        return
    if category == "events":
        for event in _mapping_rows(document.get("your_events_v2")):
            if _first_string(event, ("name", "description")) is not None:
                yield "event", event


def _mapping_rows(value: object) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                yield item


def _merge_data_item(wrapper: Mapping[str, Any], payload_key: str) -> Mapping[str, Any]:
    merged = dict(wrapper)
    data = wrapper.get("data")
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, Mapping):
                continue
            payload = item.get(payload_key)
            if isinstance(payload, Mapping):
                merged.update(payload)
                break
            if isinstance(payload, str):
                merged[payload_key] = payload
                break
    return merged


def _extract_text(raw: Mapping[str, Any]) -> str | None:
    direct = _first_string(raw, _TEXT_KEYS)
    if direct is not None:
        return direct
    data = raw.get("data")
    if isinstance(data, list):
        pieces: list[str] = []
        for item in data:
            if isinstance(item, Mapping):
                piece = _first_string(item, _TEXT_KEYS)
                if piece:
                    pieces.append(piece)
        if pieces:
            return "\n".join(pieces)
    return None


def _first_string(raw: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str):
            fixed = fix_mojibake(value)
            assert isinstance(fixed, str)
            return fixed
        if isinstance(value, Mapping):
            nested = _first_string(value, _TEXT_KEYS)
            if nested is not None:
                return nested
    return None


def _pick_mapping_values(raw: Mapping[str, Any], keys: Sequence[str]) -> dict[str, Any]:
    values = {
        key: fix_mojibake(raw[key])
        for key in keys
        if raw.get(key) not in (None, [], {})
    }
    return values


def _timestamp(raw: Mapping[str, Any]) -> tuple[int | None, str | None, int | None]:
    for key in _TIMESTAMP_KEYS:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            timestamp = int(value)
            if timestamp <= 0:
                return timestamp, None, None
            if key.endswith("_ms") or abs(timestamp) >= 100_000_000_000:
                return timestamp, "milliseconds", timestamp
            return timestamp, "seconds", timestamp * 1000
    return None, None, None


def _envelope(**values: Any) -> dict[str, Any]:
    text = values.get("text")
    return {
        "record_id": values["record_id"],
        "record_type": values["record_type"],
        "parent_id": values.get("parent_id"),
        "thread_id": values.get("thread_id"),
        "event_time_ms": values.get("event_time_ms"),
        "raw_timestamp": values.get("raw_timestamp"),
        "raw_timestamp_unit": values.get("raw_timestamp_unit"),
        "author": values.get("author"),
        "text": text,
        "text_hash": hashlib.sha256((text or "").encode("utf-8")).hexdigest(),
        "source_category": values["source_category"],
        "source_member": values["source_member"],
        "source_ordinal": values["source_ordinal"],
        "export_id": values["export_id"],
        "attachments_json": values.get("attachments_json"),
        "reactions_json": values.get("reactions_json"),
        "schema_version": SCHEMA_VERSION,
        "text_transform_version": TEXT_TRANSFORM_VERSION,
    }


def _optional_canonical_json(value: object) -> str | None:
    if value in (None, {}, []):
        return None
    return _canonical_json(fix_mojibake(value))


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
