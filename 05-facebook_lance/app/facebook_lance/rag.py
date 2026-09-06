"""Deterministic post/comment joins and privacy-bounded RAG retrieval.

The canonical records and semantic chunks remain immutable inputs.  This module
publishes only a small membership table: text and vectors continue to live in
their original tables, so rebuilding joins cannot alter embedding identity.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from lancedb.pydantic import LanceModel

from .derived_state import semantic_write_lock
from .embeddings import EmbeddingProvider, EmbeddingUnavailable
from .semantic import (
    SEMANTIC_CHUNKS_TABLE,
    SemanticChunk,
    _lexical_search_records,
    _published_table_matches,
    _read_generation_manifest,
    _semantic_search_records,
    _swap_table,
    _table_schema,
)
from .store import RECORDS_TABLE, connect_db

RETRIEVAL_DOCUMENTS_TABLE = "retrieval_documents"
JOIN_POLICY_VERSION = "facebook-post-comments-v1"
RRF_K = 60
MAX_CONTEXT_COMMENTS = 8
MAX_CITATION_TEXT_CHARS = 1200
MAX_CITATION_AUTHOR_CHARS = 256
MAX_SEMANTIC_EVIDENCE_RECORDS = 50

_FAMILIES = {
    "post": "comment",
    "group_post": "group_comment",
}
_COMMENT_TYPES = frozenset(_FAMILIES.values())


class RetrievalDocument(LanceModel):
    """One retrieval result unit backed by one or more canonical records."""

    document_id: str
    document_kind: str
    root_record_id: str
    root_record_type: str
    member_record_ids: list[str]
    member_count: int
    comment_count: int
    join_kind: str
    first_event_time_ms: int | None
    last_event_time_ms: int | None
    join_policy_version: str
    semantic_generation: str
    rag_generation: str


@dataclass(frozen=True)
class RetrievalBuildStats:
    records_seen: int
    eligible_records: int
    documents_written: int
    joined_documents: int
    standalone_documents: int
    comments_joined: int
    semantic_generation: str
    rag_generation: str


def build_retrieval_documents(db_uri: str) -> RetrievalBuildStats:
    """Derive and atomically publish deterministic post/comment membership."""

    with semantic_write_lock(db_uri):
        db = connect_db(db_uri)
        semantic_generation = _current_semantic_generation(db_uri, db)
        canonical = _canonical_text_rows(db)
        eligible = [row for row in canonical if _has_text(row)]
        base_rows = _derive_documents(canonical)
        rag_generation = _rag_generation(semantic_generation, base_rows)
        rows = [
            {
                **row,
                "semantic_generation": semantic_generation,
                "rag_generation": rag_generation,
            }
            for row in base_rows
        ]
        if _table_matches(db, rows, semantic_generation, rag_generation):
            return _build_stats(
                canonical, eligible, rows, semantic_generation, rag_generation
            )

        stage_name = f"{RETRIEVAL_DOCUMENTS_TABLE}__staging_{rag_generation[:12]}"
        for name in list(db.list_tables().tables):
            if name.startswith(f"{RETRIEVAL_DOCUMENTS_TABLE}__staging"):
                db.drop_table(name, ignore_missing=True)
        stage = db.create_table(stage_name, schema=RetrievalDocument)
        if rows:
            stage.add(rows)
        if not _stage_matches(stage, rows, semantic_generation, rag_generation):
            raise RuntimeError("retrieval document staging table is invalid")

        # The shared lock prevents canonical/semantic writers.  Recheck the
        # generation immediately before publication to make this dependency
        # explicit even if the storage implementation changes later.
        if _current_semantic_generation(db_uri, connect_db(db_uri)) != semantic_generation:
            raise RuntimeError("semantic generation changed during RAG build")
        _swap_table(db_uri, stage_name, RETRIEVAL_DOCUMENTS_TABLE)
        published = connect_db(db_uri)
        if not _table_matches(
            published, rows, semantic_generation, rag_generation
        ):
            raise RuntimeError("retrieval document publication is incomplete")
        return _build_stats(
            canonical, eligible, rows, semantic_generation, rag_generation
        )


def rag_stats(
    db_uri: str, *, semantic_generation: str | None = None
) -> dict[str, Any]:
    """Return aggregate-only state for the current retrieval generation."""

    safe_empty = {
        "ready": False,
        "documents": 0,
        "joined_post_threads": 0,
        "standalone_comments": 0,
        "rag_generation": None,
        "join_policy_version": JOIN_POLICY_VERSION,
    }
    try:
        db = connect_db(db_uri)
        if semantic_generation is None:
            generation = _current_semantic_generation(db_uri, db)
        else:
            generation = semantic_generation
            if not _manifest_generation_matches(db_uri, generation):
                return safe_empty
        rows = _published_documents(db, generation)
        if rows is None:
            return safe_empty
        canonical = _canonical_text_rows(db)
        if not _manifest_generation_matches(db_uri, generation):
            return safe_empty
    except (FileNotFoundError, RuntimeError):
        return safe_empty
    rag_generation = str(rows[0]["rag_generation"])
    joined_documents = sum(row["comment_count"] > 0 for row in rows)
    standalone_documents = sum(
        row["document_kind"] == "standalone" for row in rows
    )
    comments_joined = sum(int(row["comment_count"]) for row in rows)
    return {
        "ready": True,
        "records_seen": len(canonical),
        "eligible_records": sum(_has_text(row) for row in canonical),
        "documents_written": len(rows),
        "joined_documents": joined_documents,
        "standalone_documents": standalone_documents,
        "comments_joined": comments_joined,
        "documents": len(rows),
        "joined_post_threads": sum(
            row["document_kind"] in {"post_thread", "group_post_thread"}
            and row["comment_count"] > 0
            for row in rows
        ),
        "standalone_comments": sum(
            row["document_kind"] == "standalone"
            and row["root_record_type"] in _COMMENT_TYPES
            for row in rows
        ),
        "semantic_generation": generation,
        "rag_generation": rag_generation,
        "join_policy_version": JOIN_POLICY_VERSION,
    }


def _manifest_generation_matches(db_uri: str, generation: str) -> bool:
    try:
        manifest = _read_generation_manifest(db_uri)
    except (FileNotFoundError, RuntimeError):
        return False
    return bool(
        manifest is not None and manifest.get("semantic_generation") == generation
    )


def rag_query(
    db_uri: str,
    provider_or_none: EmbeddingProvider | None,
    query: str,
    *,
    limit: int = 10,
) -> dict[str, Any]:
    """Retrieve joined documents with bounded, source-safe citations.

    Each search channel contributes at most one rank per document.  Consequently
    a post with many matching comments cannot outvote a document with one strong
    match merely because it has more canonical members.
    """

    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError("query must contain between 1 and 200 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10:
        raise ValueError("limit must be between 1 and 10")

    db = connect_db(db_uri)
    documents = _validated_documents(db_uri, db)
    member_to_document = {
        member_id: row["document_id"]
        for row in documents
        for member_id in row["member_record_ids"]
    }
    by_document = {row["document_id"]: row for row in documents}
    if not member_to_document:
        return {"items": [], "matched_count": 0, "mode": "lexical"}
    # Retrieve every ranked record before collapsing to logical documents. A
    # large thread therefore cannot occupy a fixed record window and hide the
    # next post/message document. The underlying Lance queries already scan the
    # full local index; this only preserves their ranked record identities.
    candidate_limit = len(member_to_document)
    lexical_hits = _lexical_search_records(db_uri, query, limit=candidate_limit)
    semantic_hits: list[dict[str, Any]] = []
    mode = "lexical"
    if provider_or_none is not None:
        try:
            semantic_hits = _semantic_search_records(
                db_uri, provider_or_none, query, limit=candidate_limit
            )
        except EmbeddingUnavailable:
            semantic_hits = []
        else:
            mode = "hybrid" if lexical_hits else "semantic"

    semantic_docs = _collapse_hits(semantic_hits, member_to_document)
    lexical_docs = _collapse_hits(lexical_hits, member_to_document)
    scores: defaultdict[str, float] = defaultdict(float)
    match_kinds: defaultdict[str, set[str]] = defaultdict(set)
    for kind, hits in (("semantic", semantic_docs), ("lexical", lexical_docs)):
        for rank, hit in enumerate(hits, start=1):
            document_id = hit["document_id"]
            scores[document_id] += 1.0 / (RRF_K + rank)
            match_kinds[document_id].add(kind)
    ordered = sorted(scores, key=lambda value: (-scores[value], value))[:limit]
    selected = set(ordered)
    semantic_evidence = list(semantic_hits[:MAX_SEMANTIC_EVIDENCE_RECORDS])
    evidence_ids = {str(hit["record_id"]) for hit in semantic_evidence}
    for hit in semantic_docs:
        if hit["document_id"] in selected and hit["record_id"] not in evidence_ids:
            semantic_evidence.append(hit)
            evidence_ids.add(hit["record_id"])
    # Exact lexical hits remain evidence wherever they rank. Semantic scans have
    # no hard similarity threshold, so only the global top window plus each
    # selected document's representative are labelled as matches.
    ranked_members = _rank_member_hits(
        semantic_evidence, lexical_hits, member_to_document
    )
    canonical_by_id = {
        row["record_id"]: row for row in _canonical_text_rows(db)
    }
    items = [
        _hydrate_item(
            by_document[document_id],
            canonical_by_id,
            ranked_members[document_id],
            scores[document_id],
            match_kinds[document_id],
        )
        for document_id in ordered
    ]
    if _validated_documents(db_uri, connect_db(db_uri)) != documents:
        raise FileNotFoundError(RETRIEVAL_DOCUMENTS_TABLE)
    return {"items": items, "matched_count": len(items), "mode": mode}


def _derive_documents(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    eligible_ids = {
        str(row["record_id"]) for row in records if _has_text(row)
    }
    by_id = {str(row["record_id"]): row for row in records}
    roots_by_shared_parent: defaultdict[tuple[str, str], list[Mapping[str, Any]]] = (
        defaultdict(list)
    )
    for row in records:
        record_type = str(row["record_type"])
        if record_type not in _FAMILIES:
            continue
        parent_id = row.get("parent_id")
        if parent_id is not None:
            roots_by_shared_parent[(record_type, str(parent_id))].append(row)

    attachments: defaultdict[str, list[tuple[Mapping[str, Any], str]]] = defaultdict(list)
    attached_comments: set[str] = set()
    for comment in records:
        comment_type = str(comment["record_type"])
        if (
            comment_type not in _COMMENT_TYPES
            or str(comment["record_id"]) not in eligible_ids
        ):
            continue
        root_type = next(
            root for root, child in _FAMILIES.items() if child == comment_type
        )
        parent_id = comment.get("parent_id")
        root: Mapping[str, Any] | None = None
        join_kind = ""
        if parent_id is not None:
            direct = by_id.get(str(parent_id))
            if direct is not None and direct["record_type"] == root_type:
                root, join_kind = direct, "direct"
            else:
                candidates = roots_by_shared_parent.get(
                    (root_type, str(parent_id)), []
                )
                if len(candidates) == 1:
                    root, join_kind = candidates[0], "shared_parent"
        if root is not None:
            record_id = str(comment["record_id"])
            attachments[str(root["record_id"])].append((comment, join_kind))
            attached_comments.add(record_id)

    documents: list[dict[str, Any]] = []
    for record in records:
        record_id = str(record["record_id"])
        record_type = str(record["record_type"])
        if record_type in _COMMENT_TYPES and record_id in attached_comments:
            continue
        joined = attachments.get(record_id, []) if record_type in _FAMILIES else []
        if record_id not in eligible_ids and not joined:
            continue
        comments = sorted(
            joined,
            key=lambda value: (_event_sort_key(value[0]), str(value[0]["record_id"])),
        )
        members = [record, *(comment for comment, _ in comments)]
        member_ids = [str(member["record_id"]) for member in members]
        kinds = {kind for _, kind in comments}
        join_kind = (
            "mixed"
            if len(kinds) > 1
            else next(iter(kinds))
            if kinds
            else "root_only"
            if record_type in _FAMILIES
            else "standalone"
        )
        event_times = [
            int(member["event_time_ms"])
            for member in members
            if member.get("event_time_ms") is not None
        ]
        document_kind = (
            f"{record_type}_thread" if record_type in _FAMILIES else "standalone"
        )
        documents.append(
            {
                "document_id": _document_id(record_id, member_ids),
                "document_kind": document_kind,
                "root_record_id": record_id,
                "root_record_type": record_type,
                "member_record_ids": member_ids,
                "member_count": len(member_ids),
                "comment_count": len(comments),
                "join_kind": join_kind,
                "first_event_time_ms": min(event_times) if event_times else None,
                "last_event_time_ms": max(event_times) if event_times else None,
                "join_policy_version": JOIN_POLICY_VERSION,
            }
        )
    return sorted(documents, key=lambda row: row["document_id"])


def _document_id(root_record_id: str, member_ids: Sequence[str]) -> str:
    material = json.dumps(
        [JOIN_POLICY_VERSION, root_record_id, list(member_ids)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode()).hexdigest()


def _rag_generation(
    semantic_generation: str, rows: Sequence[Mapping[str, Any]]
) -> str:
    digest = hashlib.sha256()
    digest.update(f"{JOIN_POLICY_VERSION}\0{semantic_generation}\n".encode())
    for row in rows:
        digest.update(
            json.dumps(
                dict(row),
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        )
        digest.update(b"\n")
    return digest.hexdigest()


def _canonical_text_rows(db: Any) -> list[dict[str, Any]]:
    if RECORDS_TABLE not in db.list_tables().tables:
        raise FileNotFoundError(RECORDS_TABLE)
    table = db.open_table(RECORDS_TABLE)
    columns = [
        "record_id",
        "record_type",
        "parent_id",
        "event_time_ms",
        "author",
        "text",
    ]
    count = table.count_rows()
    if not count:
        return []
    rows = table.search().select(columns).limit(count).to_arrow().to_pylist()
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        record_id = str(row["record_id"])
        previous = unique.get(record_id)
        encoded = json.dumps(row, sort_keys=True, ensure_ascii=False, default=str)
        if previous is None or encoded < json.dumps(
            previous, sort_keys=True, ensure_ascii=False, default=str
        ):
            unique[record_id] = row
    return sorted(unique.values(), key=lambda row: str(row["record_id"]))


def _has_text(row: Mapping[str, Any]) -> bool:
    text = row.get("text")
    return isinstance(text, str) and bool(text.strip())


def _event_sort_key(row: Mapping[str, Any]) -> tuple[int, int]:
    value = row.get("event_time_ms")
    return (1, 0) if value is None else (0, int(value))


def _current_semantic_generation(db_uri: str, db: Any) -> str:
    manifest = _read_generation_manifest(db_uri)
    if manifest is None or manifest["semantic_generation"] is None:
        raise FileNotFoundError("semantic-generation.json")
    generation = str(manifest["semantic_generation"])
    if not _published_table_matches(
        db,
        SEMANTIC_CHUNKS_TABLE,
        SemanticChunk,
        generation,
        int(manifest["chunks"]),
    ):
        raise FileNotFoundError(SEMANTIC_CHUNKS_TABLE)
    return generation


def _stage_matches(
    table: Any,
    rows: Sequence[Mapping[str, Any]],
    semantic_generation: str,
    rag_generation: str,
) -> bool:
    if not _table_schema(table).equals(
        RetrievalDocument.to_arrow_schema(), check_metadata=False
    ) or table.count_rows() != len(rows):
        return False
    actual = (
        table.search().limit(len(rows)).to_arrow().to_pylist() if rows else []
    )
    return _rows_are_exact(actual, rows, semantic_generation, rag_generation)


def _table_matches(
    db: Any,
    rows: Sequence[Mapping[str, Any]],
    semantic_generation: str,
    rag_generation: str,
) -> bool:
    if RETRIEVAL_DOCUMENTS_TABLE not in db.list_tables().tables:
        return False
    return _stage_matches(
        db.open_table(RETRIEVAL_DOCUMENTS_TABLE),
        rows,
        semantic_generation,
        rag_generation,
    )


def _rows_are_exact(
    actual: Sequence[Mapping[str, Any]],
    expected: Sequence[Mapping[str, Any]],
    semantic_generation: str,
    rag_generation: str,
) -> bool:
    if any(
        row.get("semantic_generation") != semantic_generation
        or row.get("rag_generation") != rag_generation
        or row.get("join_policy_version") != JOIN_POLICY_VERSION
        for row in actual
    ):
        return False
    normalize = lambda row: json.dumps(
        dict(row), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    return sorted(map(normalize, actual)) == sorted(map(normalize, expected))


def _build_stats(
    canonical: Sequence[Mapping[str, Any]],
    eligible: Sequence[Mapping[str, Any]],
    rows: Sequence[Mapping[str, Any]],
    semantic_generation: str,
    rag_generation: str,
) -> RetrievalBuildStats:
    return RetrievalBuildStats(
        records_seen=len(canonical),
        eligible_records=len(eligible),
        documents_written=len(rows),
        joined_documents=sum(row["comment_count"] > 0 for row in rows),
        standalone_documents=sum(row["document_kind"] == "standalone" for row in rows),
        comments_joined=sum(int(row["comment_count"]) for row in rows),
        semantic_generation=semantic_generation,
        rag_generation=rag_generation,
    )


def _validated_documents(db_uri: str, db: Any) -> list[dict[str, Any]]:
    generation = _current_semantic_generation(db_uri, db)
    rows = _published_documents(db, generation)
    if rows is None:
        raise FileNotFoundError(RETRIEVAL_DOCUMENTS_TABLE)
    return rows


def _published_documents(
    db: Any, semantic_generation: str
) -> list[dict[str, Any]] | None:
    """Validate the published table against its canonical-bound generation."""

    names = set(db.list_tables().tables)
    if {RECORDS_TABLE, RETRIEVAL_DOCUMENTS_TABLE} - names:
        return None
    table = db.open_table(RETRIEVAL_DOCUMENTS_TABLE)
    if not _table_schema(table).equals(
        RetrievalDocument.to_arrow_schema(), check_metadata=False
    ):
        return None
    count = table.count_rows()
    if not count:
        return None
    rows = table.search().limit(count).to_arrow().to_pylist()
    rag_generations = {str(row["rag_generation"]) for row in rows}
    if (
        len(rag_generations) != 1
        or any(
            row["semantic_generation"] != semantic_generation
            or row["join_policy_version"] != JOIN_POLICY_VERSION
            for row in rows
        )
    ):
        return None
    rag_generation = next(iter(rag_generations))
    base_rows = [
        {
            key: value
            for key, value in row.items()
            if key not in {"semantic_generation", "rag_generation"}
        }
        for row in rows
    ]
    expected_generation = _rag_generation(
        semantic_generation,
        sorted(base_rows, key=lambda row: row["document_id"]),
    )
    if expected_generation != rag_generation:
        return None
    return sorted(rows, key=lambda row: row["document_id"])


def _collapse_hits(
    hits: Sequence[Mapping[str, Any]], member_to_document: Mapping[str, str]
) -> list[dict[str, str]]:
    collapsed: list[dict[str, str]] = []
    seen: set[str] = set()
    for hit in hits:
        record_id = str(hit["record_id"])
        document_id = member_to_document.get(record_id)
        if document_id is None or document_id in seen:
            continue
        seen.add(document_id)
        collapsed.append({"document_id": document_id, "record_id": record_id})
    return collapsed


def _rank_member_hits(
    semantic_hits: Sequence[Mapping[str, Any]],
    lexical_hits: Sequence[Mapping[str, Any]],
    member_to_document: Mapping[str, str],
) -> dict[str, list[str]]:
    """Keep member match priority separate from document-level scoring."""

    scores: defaultdict[str, defaultdict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    for hits in (semantic_hits, lexical_hits):
        for rank, hit in enumerate(hits, start=1):
            record_id = str(hit["record_id"])
            document_id = member_to_document.get(record_id)
            if document_id is not None:
                scores[document_id][record_id] += 1.0 / (RRF_K + rank)
    return {
        document_id: sorted(
            member_scores,
            key=lambda record_id: (-member_scores[record_id], record_id),
        )
        for document_id, member_scores in scores.items()
    }


def _hydrate_item(
    document: Mapping[str, Any],
    canonical_by_id: Mapping[str, Mapping[str, Any]],
    matched_ids: Sequence[str],
    score: float,
    match_kinds: set[str],
) -> dict[str, Any]:
    root_id = str(document["root_record_id"])
    root = canonical_by_id[root_id]
    chronological_ids = list(document["member_record_ids"][1:])
    matched_set = set(matched_ids)
    matched_comment_ids = [
        record_id for record_id in matched_ids if record_id in chronological_ids
    ][:MAX_CONTEXT_COMMENTS]
    selected_ids = set(matched_comment_ids)
    for record_id in chronological_ids:
        if len(selected_ids) == MAX_CONTEXT_COMMENTS:
            break
        selected_ids.add(record_id)
    # Membership is already chronological. Filtering it after selection keeps
    # display order stable while ensuring matching comments receive priority
    # when a long thread must be truncated.
    comments = [
        canonical_by_id[record_id]
        for record_id in chronological_ids
        if record_id in selected_ids
    ]
    citations = [_citation(root, root_id in matched_set, True)]
    citations.extend(
        _citation(row, str(row["record_id"]) in matched_set, False)
        for row in comments
    )
    return {
        "document_id": document["document_id"],
        "document_kind": document["document_kind"],
        "root_record_id": root_id,
        "root_record_type": document["root_record_type"],
        "member_count": document["member_count"],
        "comment_count": document["comment_count"],
        "omitted_comment_count": max(
            0, int(document["comment_count"]) - len(comments)
        ),
        "join_kind": document["join_kind"],
        "first_event_time_ms": document["first_event_time_ms"],
        "last_event_time_ms": document["last_event_time_ms"],
        "rank_score": score,
        "match_kind": "+".join(sorted(match_kinds)),
        "citations": citations,
    }


def _citation(
    row: Mapping[str, Any], matched: bool, is_root: bool
) -> dict[str, Any]:
    text_value = row.get("text")
    text = text_value if isinstance(text_value, str) else ""
    truncated = len(text) > MAX_CITATION_TEXT_CHARS
    author_value = row.get("author")
    author = (
        str(author_value)[:MAX_CITATION_AUTHOR_CHARS]
        if author_value is not None
        else None
    )
    record_type = str(row["record_type"])
    role = (
        "post"
        if is_root and record_type in _FAMILIES
        else "comment"
        if not is_root or record_type in _COMMENT_TYPES
        else record_type
    )
    return {
        "record_id": row["record_id"],
        "record_type": record_type,
        "event_time_ms": row["event_time_ms"],
        "author": author,
        "text": text[:MAX_CITATION_TEXT_CHARS],
        "role": role,
        "truncated": truncated,
        "is_root": is_root,
        "matched": matched,
    }
