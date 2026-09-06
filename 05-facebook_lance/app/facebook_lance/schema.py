"""Canonical Arrow schema for normalized Facebook atoms."""

from __future__ import annotations

import pyarrow as pa

SCHEMA_VERSION = 1
TEXT_TRANSFORM_VERSION = "facebook-text-v1"


def arrow_schema() -> pa.Schema:
    return pa.schema(
        [
            pa.field("record_id", pa.string(), nullable=False),
            pa.field("record_type", pa.string(), nullable=False),
            pa.field("parent_id", pa.string(), nullable=True),
            pa.field("thread_id", pa.string(), nullable=True),
            pa.field("event_time_ms", pa.int64(), nullable=True),
            pa.field("raw_timestamp", pa.int64(), nullable=True),
            pa.field("raw_timestamp_unit", pa.string(), nullable=True),
            pa.field("author", pa.string(), nullable=True),
            pa.field("text", pa.string(), nullable=True),
            pa.field("text_hash", pa.string(), nullable=False),
            pa.field("source_category", pa.string(), nullable=False),
            pa.field("source_member", pa.string(), nullable=False),
            pa.field("source_ordinal", pa.int64(), nullable=False),
            pa.field("export_id", pa.string(), nullable=False),
            pa.field("attachments_json", pa.string(), nullable=True),
            pa.field("reactions_json", pa.string(), nullable=True),
            pa.field("schema_version", pa.int32(), nullable=False),
            pa.field("text_transform_version", pa.string(), nullable=False),
        ]
    )
