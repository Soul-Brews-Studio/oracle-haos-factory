"""Typed LanceDB row contracts for the LINE archive."""

from __future__ import annotations

from lancedb.pydantic import LanceModel, Vector

VECTOR_DIM = 1024
EMBED_MODEL = "@cf/baai/bge-m3"


class LineMessage(LanceModel):
    """Lossless scalar projection of webhook-relay chat_messages."""

    record_key: str
    rowid: int | None = None
    source_id: str
    chat: str
    sender: str
    text: str
    type: str
    sent_at: str
    source: str
    media_ref: str | None = None
    import_key: str | None = None
    created_at: str
    source_file: str


class LineVector(LanceModel):
    """Derived semantic index, joined back to LineMessage by record_key."""

    record_key: str
    source_id: str
    chat: str
    sender: str
    text: str
    sent_at: str
    model: str = EMBED_MODEL
    vector: Vector(VECTOR_DIM)  # type: ignore[reportInvalidTypeForm]


class ImportFile(LanceModel):
    """Manifest row used to skip unchanged D1 export pages."""

    path: str
    mtime_ns: int
    size: int
    rows: int
    imported_at: str
