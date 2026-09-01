"""Bounded, idempotent LanceDB persistence for canonical atoms."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import lancedb
import pyarrow as pa

from .derived_state import invalidate_semantic_generation, semantic_write_lock
from .normalize import iter_normalized_records
from .schema import arrow_schema

RECORDS_TABLE = "records"


@dataclass(frozen=True)
class ImportStats:
    export_id: str
    records_seen: int
    batches: int
    table_rows: int
    by_type: dict[str, int]


def connect_db(uri: str | Path) -> Any:
    return lancedb.connect(str(uri))


def ensure_records_table(db: Any) -> Any:
    """Open or create the records table and enforce its exact schema."""

    expected = arrow_schema()
    table = db.create_table(RECORDS_TABLE, schema=expected, exist_ok=True)
    schema_or_loader = table.schema
    actual_schema = cast(
        pa.Schema,
        schema_or_loader() if callable(schema_or_loader) else schema_or_loader,
    )
    if not actual_schema.equals(expected, check_metadata=False):
        raise ValueError("records table schema does not match the canonical schema")
    return table


def import_zip(
    zip_path: Path, db_uri: str | Path, batch_size: int = 500
) -> ImportStats:
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")

    db = connect_db(db_uri)
    with semantic_write_lock(db_uri):
        invalidate_semantic_generation(db_uri)
        table = ensure_records_table(db)
        pending: list[dict[str, Any]] = []
        by_type: Counter[str] = Counter()
        records_seen = 0
        batches = 0
        export_id = ""

        for record in iter_normalized_records(zip_path):
            pending.append(record)
            export_id = record["export_id"]
            by_type[record["record_type"]] += 1
            records_seen += 1
            if len(pending) >= batch_size:
                _merge_batch(table, pending)
                pending.clear()
                batches += 1
        if pending:
            _merge_batch(table, pending)
            batches += 1

        return ImportStats(
            export_id=export_id,
            records_seen=records_seen,
            batches=batches,
            table_rows=table.count_rows(),
            by_type=dict(sorted(by_type.items())),
        )


def _merge_batch(table: Any, records: list[dict[str, Any]]) -> None:
    # Lance merge-insert does not collapse duplicate keys inside one incoming
    # Arrow batch. Meta exports can repeat the same message across split files,
    # so make the batch unique before crossing the storage boundary.
    unique = {record["record_id"]: record for record in records}
    batch = pa.Table.from_pylist(list(unique.values()), schema=arrow_schema())
    (
        table.merge_insert("record_id")
        .when_matched_update_all()
        .when_not_matched_insert_all()
        .execute(batch)
    )
