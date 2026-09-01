"""Derived multilingual semantic index and deterministic topic projection.

The canonical ``records`` table remains the source of truth.  Everything in
this module is rebuildable and lives in separate Lance tables.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from lancedb.index import FTS
from lancedb.pydantic import LanceModel, Vector
from lancedb.query import MatchQuery

from .derived_state import (
    SEMANTIC_GENERATION_MANIFEST,
)
from .derived_state import (
    semantic_write_lock as _semantic_build_lock,
)
from .embeddings import (
    DOCUMENT_PREFIX,
    E5_VECTOR_SPACE_ID,
    MODEL_ID,
    MODEL_REVISION,
    QUERY_PREFIX,
    VECTOR_DIMENSION,
    EmbeddingProvider,
    EmbeddingUnavailable,
)
from .store import RECORDS_TABLE, connect_db

SEMANTIC_CHUNKS_TABLE = "semantic_chunks"
SEMANTIC_TOPICS_TABLE = "semantic_topics"
SEMANTIC_TOPIC_POINTS_TABLE = "semantic_topic_points"
CHUNK_POLICY_VERSION = "e5-token-window-v2"
TOPIC_ALGORITHM_VERSION = "spherical-kmeans-pca-v2"
DEFAULT_CONTENT_TOKENS = 448
DEFAULT_TOKEN_OVERLAP = 64
DEFAULT_TOPIC_COUNT = 24

_GENERATION_MANIFEST = SEMANTIC_GENERATION_MANIFEST
_GENERATION_MANIFEST_VERSION = 1
_WORDISH = re.compile(r"[^\W_]+", flags=re.UNICODE)
_GENERIC_STOP_WORDS = frozenset(
    {
        "and",
        "are",
        "but",
        "for",
        "from",
        "have",
        "not",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "you",
        "was",
        "with",
        "ก็",
        "กัน",
        "กับ",
        "เขา",
        "เค้า",
        "ครับ",
        "คับ",
        "ค่ะ",
        "คะ",
        "คุณ",
        "จริง",
        "จ้ะ",
        "จะ",
        "จาก",
        "ฉัน",
        "ดี",
        "ด้วย",
        "ดู",
        "เดี๋ยว",
        "ต้อง",
        "ตอน",
        "ทำ",
        "นะ",
        "นี้",
        "พี่",
        "มา",
        "มาก",
        "มี",
        "มัน",
        "ยัง",
        "เรา",
        "เลย",
        "ละ",
        "แล้ว",
        "ว่า",
        "อยู่",
        "อยาก",
        "อะ",
        "อ่ะ",
        "อะไร",
        "โดย",
        "แต่",
        "ไม่",
        "ไป",
        "ป่ะ",
        "ผม",
        "ได้",
        "ของ",
        "ที่",
        "และ",
        "ใน",
        "เป็น",
        "ให้",
    }
)


class SemanticChunk(LanceModel):
    """One retrieval atom derived from exactly one canonical record."""

    chunk_id: str
    record_id: str
    chunk_index: int
    chunk_count: int
    record_type: str
    parent_id: str | None
    thread_id: str | None
    event_time_ms: int | None
    source_category: str
    source_text_hash: str
    search_text: str
    lexical_text: str
    lexical_tokenizer_id: str
    search_text_hash: str
    # LanceDB intentionally exposes Vector as a runtime Pydantic field factory,
    # even though its typing surface does not model that annotation form.
    vector: Vector(VECTOR_DIMENSION)  # pyright: ignore[reportInvalidTypeForm]
    vector_space_id: str
    model_id: str
    model_revision: str
    document_prefix: str
    query_prefix: str
    pooling: str
    normalization: str
    distance_metric: str
    chunk_policy_version: str
    text_transform_version: str
    semantic_generation: str


class SemanticTopic(LanceModel):
    """Aggregate topic metadata derived from record-level mean vectors."""

    topic_id: str
    topic_version: str
    label: str
    size: int
    keywords: list[str]
    centroid: Vector(VECTOR_DIMENSION)  # pyright: ignore[reportInvalidTypeForm]
    exemplar_record_ids: list[str]
    semantic_generation: str


class SemanticTopicPoint(LanceModel):
    """A deterministic two-dimensional topic-map position for one record."""

    record_id: str
    topic_id: str
    topic_version: str
    x: float
    y: float
    distance: float
    semantic_generation: str


@dataclass(frozen=True)
class SemanticBuildStats:
    records_seen: int
    eligible_records: int
    chunks_written: int
    embedding_batches: int
    vector_space_id: str
    semantic_generation: str


@dataclass(frozen=True)
class TopicBuildStats:
    records_clustered: int
    topics_written: int
    points_written: int
    topic_version: str
    semantic_generation: str


def prepare_document_text(text: str) -> str:
    """Return the immutable E5 document input without changing source text."""

    return f"{DOCUMENT_PREFIX}{text}"


def prepare_query_text(text: str) -> str:
    """Return the immutable E5 query input without changing source text."""

    return f"{QUERY_PREFIX}{text}"


def normalize_vector(vector: Sequence[float] | np.ndarray) -> list[float]:
    """Return a finite unit vector or reject the value."""

    values = np.asarray(vector, dtype=np.float64)
    if values.ndim != 1 or not values.size or not np.isfinite(values).all():
        raise ValueError("vector must be one-dimensional and finite")
    norm = float(np.linalg.norm(values))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("vector norm must be positive and finite")
    return (values / norm).astype(np.float32).tolist()


def make_chunk_id(
    record_id: str,
    chunk_index: int,
    source_text_hash: str,
    vector_space_id: str = E5_VECTOR_SPACE_ID,
) -> str:
    """Create a stable identifier bound to source, position, and vector space."""

    material = "\0".join(
        (vector_space_id, record_id, str(chunk_index), source_text_hash)
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def prepare_lexical_text(text: str) -> str:
    """Segment Thai with PyThaiNLP ``newmm-safe`` for lexical inspection.

    PyThaiNLP is an explicit semantic extra.  The fallback remains deterministic
    for non-Thai development fixtures, but refuses to pretend it can segment
    Thai when that dependency is absent.
    """

    normalized = unicodedata.normalize("NFC", text).strip()
    if not normalized:
        return ""
    try:
        from pythainlp.tokenize import word_tokenize
    except ImportError as error:
        if any("\u0e00" <= character <= "\u0e7f" for character in normalized):
            raise RuntimeError("PyThaiNLP is required for Thai lexical text") from error
        return " ".join(_WORDISH.findall(normalized.casefold()))
    tokens = word_tokenize(
        normalized,
        engine="newmm-safe",
        keep_whitespace=False,
        join_broken_num=True,
    )
    return " ".join(token.strip() for token in tokens if token.strip())


def lexical_tokenizer_id() -> str:
    """Return the exact lexical tokenizer identity used by this process."""

    try:
        import pythainlp
    except ImportError:
        return "unicode-wordish-fallback-v1"
    return f"pythainlp:newmm-safe:{pythainlp.__version__}"


def chunk_record(
    record: Mapping[str, Any],
    tokenizer: Any,
    *,
    max_tokens: int = DEFAULT_CONTENT_TOKENS,
    overlap: int = DEFAULT_TOKEN_OVERLAP,
) -> Iterable[dict[str, Any]]:
    """Yield chunk metadata without ever crossing a canonical record boundary."""

    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0:
        raise ValueError("max_tokens must be positive")
    if (
        isinstance(overlap, bool)
        or not isinstance(overlap, int)
        or overlap < 0
        or overlap >= max_tokens
    ):
        raise ValueError("overlap must be between zero and max_tokens")
    text = record.get("text")
    if not isinstance(text, str) or not text.strip():
        return
    normalized = unicodedata.normalize("NFC", text).strip()
    encoding = tokenizer.encode(normalized, add_special_tokens=False)
    token_ids = list(encoding.ids)
    if not token_ids:
        return
    starts = list(range(0, len(token_ids), max_tokens - overlap))
    windows = [token_ids[start : start + max_tokens] for start in starts]
    if len(windows) > 1 and len(windows[-1]) <= overlap:
        windows.pop()
    decoded_windows = [
        tokenizer.decode(window, skip_special_tokens=True).strip() for window in windows
    ]
    decoded = [value for value in decoded_windows if value]
    # Some one-character messages tokenize only to a special/unknown token that
    # disappears during decoding. Keep the exact source as a lexical/retrieval
    # atom rather than silently dropping an otherwise non-empty record.
    if not decoded:
        decoded = [normalized]
    yield from _chunk_rows(record, decoded)


def build_semantic_index(
    db_uri: str,
    provider: EmbeddingProvider,
    *,
    tokenizer: Any | None = None,
    batch_size: int = 16,
    max_tokens: int = DEFAULT_CONTENT_TOKENS,
    overlap: int = DEFAULT_TOKEN_OVERLAP,
) -> SemanticBuildStats:
    """Build or resume a generation-bound derived semantic table."""

    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size <= 0:
        raise ValueError("batch_size must be positive")
    if provider.vector_space_id != E5_VECTOR_SPACE_ID:
        raise EmbeddingUnavailable("provider vector space does not match the index")
    provider_tokenizer = tokenizer or getattr(provider, "tokenizer", None)
    if provider_tokenizer is None:
        raise EmbeddingUnavailable("the pinned tokenizer is required for semantic builds")

    with _semantic_build_lock(db_uri):
        db = connect_db(db_uri)
        if RECORDS_TABLE not in db.list_tables().tables:
            raise FileNotFoundError(RECORDS_TABLE)
        canonical = db.open_table(RECORDS_TABLE)
        canonical_schema = _table_schema(canonical)
        records = _canonical_rows(canonical)
        generation = _canonical_generation(
            records,
            max_tokens=max_tokens,
            overlap=overlap,
            tokenizer_id=lexical_tokenizer_id(),
        )

        chunks: list[dict[str, Any]] = []
        eligible_records = 0
        for record in sorted(records, key=lambda item: item["record_id"]):
            text = record.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            eligible_records += 1
            for chunk in chunk_record(
                record,
                provider_tokenizer,
                max_tokens=max_tokens,
                overlap=overlap,
            ):
                chunks.append({**chunk, "semantic_generation": generation})

        expected_ids = {chunk["chunk_id"] for chunk in chunks}
        manifest = _read_generation_manifest(db_uri)
        if (
            manifest is not None
            and manifest["semantic_generation"] == generation
            and manifest["chunks"] == len(chunks)
            and _published_table_matches(
                db, SEMANTIC_CHUNKS_TABLE, SemanticChunk, generation, len(chunks)
            )
        ):
            return SemanticBuildStats(
                records_seen=len(records),
                eligible_records=eligible_records,
                chunks_written=len(chunks),
                embedding_batches=0,
                vector_space_id=E5_VECTOR_SPACE_ID,
                semantic_generation=generation,
            )

        # Prove the embedding boundary is available before making the prior
        # published generation unavailable.  In particular, a remote provider
        # failure must neither erase the ready manifest nor receive document
        # text.  A valid same-generation publication returned above remains a
        # true no-op and therefore does not need provider access.
        provider.preflight()

        _write_generation_manifest(
            db_uri,
            semantic_generation=None,
            chunks=0,
            topics_generation=None,
            topics=0,
            topic_points=0,
            topic_version=None,
        )
        stage_name = f"{SEMANTIC_CHUNKS_TABLE}__staging_{generation[:12]}"
        _drop_other_stages(db, SEMANTIC_CHUNKS_TABLE, stage_name)
        stage, existing_ids = _open_resumable_stage(
            db, stage_name, SemanticChunk, generation, expected_ids
        )
        remaining = [chunk for chunk in chunks if chunk["chunk_id"] not in existing_ids]
        embedding_batches = 0
        for start in range(0, len(remaining), batch_size):
            batch = remaining[start : start + batch_size]
            vectors = provider.embed(
                [chunk["search_text"] for chunk in batch], kind="document"
            )
            if len(vectors) != len(batch):
                raise EmbeddingUnavailable("provider returned an invalid vector count")
            rows = []
            for chunk, vector in zip(batch, vectors, strict=True):
                if len(vector) != VECTOR_DIMENSION:
                    raise EmbeddingUnavailable("provider returned an invalid dimension")
                rows.append({**chunk, "vector": normalize_vector(vector)})
            if rows:
                stage.add(rows)
            embedding_batches += 1

        if stage.count_rows() != len(chunks):
            raise RuntimeError("semantic staging row count is invalid")
        current_records = _canonical_rows(db.open_table(RECORDS_TABLE))
        if (
            not _table_schema(db.open_table(RECORDS_TABLE)).equals(
                canonical_schema, check_metadata=False
            )
            or _canonical_generation(
                current_records,
                max_tokens=max_tokens,
                overlap=overlap,
                tokenizer_id=lexical_tokenizer_id(),
            )
            != generation
        ):
            raise RuntimeError("canonical records changed during semantic build")

        if chunks:
            stage.create_index(
                "search_text",
                config=FTS(
                    base_tokenizer="ngram",
                    ngram_min_length=3,
                    ngram_max_length=3,
                    lower_case=True,
                    stem=False,
                    remove_stop_words=False,
                    ascii_folding=False,
                ),
                replace=True,
                name="search_text_ngrams",
            )
            stage.create_index(
                "lexical_text",
                config=FTS(
                    base_tokenizer="whitespace",
                    max_token_length=None,
                    lower_case=True,
                    stem=False,
                    remove_stop_words=False,
                    ascii_folding=False,
                ),
                replace=True,
                name="lexical_text_words",
            )
        _swap_table(db_uri, stage_name, SEMANTIC_CHUNKS_TABLE)
        if _canonical_generation(
            _canonical_rows(db.open_table(RECORDS_TABLE)),
            max_tokens=max_tokens,
            overlap=overlap,
            tokenizer_id=lexical_tokenizer_id(),
        ) != generation:
            raise RuntimeError("canonical records changed during semantic publish")
        if not _published_table_matches(
            connect_db(db_uri),
            SEMANTIC_CHUNKS_TABLE,
            SemanticChunk,
            generation,
            len(chunks),
        ):
            raise RuntimeError("semantic publication is incomplete")
        _write_generation_manifest(
            db_uri,
            semantic_generation=generation,
            chunks=len(chunks),
            topics_generation=None,
            topics=0,
            topic_points=0,
            topic_version=None,
        )
        return SemanticBuildStats(
            records_seen=len(records),
            eligible_records=eligible_records,
            chunks_written=len(chunks),
            embedding_batches=embedding_batches,
            vector_space_id=E5_VECTOR_SPACE_ID,
            semantic_generation=generation,
        )


def semantic_search(
    db_uri: str,
    provider: EmbeddingProvider,
    query: str,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Run an exact cosine scan and deduplicate chunks by canonical record."""

    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError("query must contain between 1 and 200 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    return _semantic_search_records(db_uri, provider, query, limit=limit)


def _semantic_search_records(
    db_uri: str,
    provider: EmbeddingProvider,
    query: str,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Return ranked records for a validated internal retrieval request."""

    if provider.vector_space_id != E5_VECTOR_SPACE_ID:
        raise EmbeddingUnavailable("provider vector space does not match the index")
    db = connect_db(db_uri)
    if SEMANTIC_CHUNKS_TABLE not in db.list_tables().tables:
        raise FileNotFoundError(SEMANTIC_CHUNKS_TABLE)
    manifest = _read_generation_manifest(db_uri)
    if manifest is None or manifest["semantic_generation"] is None:
        raise FileNotFoundError(_GENERATION_MANIFEST)
    generation = manifest["semantic_generation"]
    if not _published_table_matches(
        db,
        SEMANTIC_CHUNKS_TABLE,
        SemanticChunk,
        generation,
        manifest["chunks"],
    ):
        raise FileNotFoundError(SEMANTIC_CHUNKS_TABLE)
    vector = provider.embed([query.strip()], kind="query")
    if len(vector) != 1 or len(vector[0]) != VECTOR_DIMENSION:
        raise EmbeddingUnavailable("provider returned an invalid query vector")
    table = db.open_table(SEMANTIC_CHUNKS_TABLE)
    candidate_limit = table.count_rows()
    result = (
        table
        .search(normalize_vector(vector[0]), vector_column_name="vector")
        .distance_type("cosine")
        .bypass_vector_index()
        .where(_vector_space_filter(generation))
        .select(["record_id", "chunk_id", "chunk_index", "record_type"])
        .limit(candidate_limit)
        .to_arrow()
        .to_pylist()
    )
    hits: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in result:
        record_id = row["record_id"]
        if record_id in seen:
            continue
        seen.add(record_id)
        hits.append(
            {
                "record_id": record_id,
                "record_type": row["record_type"],
                "chunk_id": row["chunk_id"],
                "chunk_index": row["chunk_index"],
                "distance": float(row["_distance"]),
            }
        )
        if len(hits) == limit:
            break
    return hits


def lexical_search(
    db_uri: str,
    query: str,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Search raw trigrams and Thai-segmented words, then fuse their ranks."""

    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError("query must contain between 1 and 200 characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    return _lexical_search_records(db_uri, query, limit=limit)


def _lexical_search_records(
    db_uri: str,
    query: str,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Return ranked records for a validated internal retrieval request."""

    db = connect_db(db_uri)
    manifest = _read_generation_manifest(db_uri)
    if manifest is None or manifest["semantic_generation"] is None:
        raise FileNotFoundError(_GENERATION_MANIFEST)
    generation = manifest["semantic_generation"]
    if not _published_table_matches(
        db,
        SEMANTIC_CHUNKS_TABLE,
        SemanticChunk,
        generation,
        manifest["chunks"],
    ):
        raise FileNotFoundError(SEMANTIC_CHUNKS_TABLE)
    table = db.open_table(SEMANTIC_CHUNKS_TABLE)
    candidate_limit = table.count_rows()
    sources: list[list[dict[str, Any]]] = []
    raw_query = query.strip()
    if len(raw_query) >= 3:
        sources.append(
            _fts_record_hits(
                table,
                # LanceDB's stub marks runtime-defaulted MatchQuery options as
                # required; the public two-argument constructor is functional.
                MatchQuery(  # pyright: ignore[reportCallIssue]
                    raw_query, "search_text"
                ),
                generation,
                candidate_limit,
            )
        )
    try:
        word_query = prepare_lexical_text(raw_query)
    except RuntimeError:
        # The raw ngram index is independent of optional Thai word segmentation.
        # Keep it searchable when PyThaiNLP is absent instead of failing the query.
        word_query = ""
    if word_query:
        sources.append(
            _fts_record_hits(
                table,
                MatchQuery(  # pyright: ignore[reportCallIssue]
                    word_query, "lexical_text"
                ),
                generation,
                candidate_limit,
            )
        )

    scores: defaultdict[str, float] = defaultdict(float)
    best: dict[str, dict[str, Any]] = {}
    for rows in sources:
        for rank, row in enumerate(rows, start=1):
            record_id = row["record_id"]
            scores[record_id] += 1.0 / (60 + rank)
            best.setdefault(record_id, row)
    ordered = sorted(scores, key=lambda item: (-scores[item], item))[:limit]
    return [
        {
            "record_id": record_id,
            "record_type": best[record_id]["record_type"],
            "chunk_id": best[record_id]["chunk_id"],
            "chunk_index": best[record_id]["chunk_index"],
            "lexical_score": float(best[record_id]["_score"]),
            "rank_score": scores[record_id],
            "match_kind": "lexical",
        }
        for record_id in ordered
    ]


def merge_ranked_hits(
    semantic_hits: Sequence[Mapping[str, Any]],
    lexical_hits: Sequence[Mapping[str, Any]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Reciprocal-rank fuse compatible semantic and lexical result lists."""

    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    scores: defaultdict[str, float] = defaultdict(float)
    semantic_by_id: dict[str, Mapping[str, Any]] = {}
    lexical_by_id: dict[str, Mapping[str, Any]] = {}
    for rank, hit in enumerate(semantic_hits, start=1):
        record_id = str(hit["record_id"])
        semantic_by_id.setdefault(record_id, hit)
        scores[record_id] += 1.0 / (60 + rank)
    for rank, hit in enumerate(lexical_hits, start=1):
        record_id = str(hit["record_id"])
        lexical_by_id.setdefault(record_id, hit)
        scores[record_id] += 1.0 / (60 + rank)
    ordered = sorted(scores, key=lambda item: (-scores[item], item))[:limit]
    merged: list[dict[str, Any]] = []
    for record_id in ordered:
        semantic = semantic_by_id.get(record_id)
        lexical = lexical_by_id.get(record_id)
        source = semantic or lexical
        assert source is not None
        item = dict(source)
        item["rank_score"] = scores[record_id]
        item["match_kind"] = (
            "semantic+lexical"
            if semantic is not None and lexical is not None
            else "semantic"
            if semantic is not None
            else "lexical"
        )
        if lexical is not None:
            item["lexical_score"] = float(lexical["lexical_score"])
        merged.append(item)
    return merged


def spherical_kmeans(
    vectors: Sequence[Sequence[float]] | np.ndarray,
    *,
    k: int,
    seed: int = 0,
    max_iterations: int = 50,
    tolerance: float = 1e-6,
) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic spherical k-means with farthest-first initialization."""

    matrix = _normalized_matrix(vectors)
    row_count = matrix.shape[0]
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= row_count:
        raise ValueError("k must be between one and the number of vectors")
    if max_iterations <= 0 or tolerance < 0:
        raise ValueError("invalid clustering convergence settings")

    first = int(seed) % row_count
    chosen = [first]
    while len(chosen) < k:
        similarities = matrix @ matrix[chosen].T
        nearest_distance = 1.0 - similarities.max(axis=1)
        nearest_distance[chosen] = -1.0
        chosen.append(int(np.argmax(nearest_distance)))
    centroids = matrix[chosen].copy()
    labels = np.zeros(row_count, dtype=np.int64)

    for _ in range(max_iterations):
        previous = centroids.copy()
        labels = np.argmax(matrix @ centroids.T, axis=1)
        for cluster in range(k):
            members = matrix[labels == cluster]
            if not len(members):
                distances = 1.0 - np.max(matrix @ centroids.T, axis=1)
                centroids[cluster] = matrix[int(np.argmax(distances))]
                continue
            centroids[cluster] = normalize_vector(members.mean(axis=0))
        if float(np.max(np.abs(centroids - previous))) <= tolerance:
            break
    labels = np.argmax(matrix @ centroids.T, axis=1)
    return labels, centroids


def project_pca(
    vectors: Sequence[Sequence[float]] | np.ndarray,
) -> np.ndarray:
    """Project vectors to two reproducible principal axes.

    Equal eigenvalues do not define unique eigenvectors.  Resolve each tied
    eigenspace against the canonical feature axes so topic coordinates do not
    depend on whichever orthonormal basis a BLAS implementation returns.
    """

    matrix = np.asarray(vectors, dtype=np.float64)
    if matrix.ndim != 2 or not matrix.shape[0] or not matrix.shape[1]:
        raise ValueError("vectors must be a non-empty matrix")
    if not np.isfinite(matrix).all():
        raise ValueError("vectors must be finite")
    centered = matrix - matrix.mean(axis=0, keepdims=True)
    if matrix.shape[0] == 1:
        return np.zeros((1, 2), dtype=np.float64)
    covariance = centered.T @ centered / max(matrix.shape[0] - 1, 1)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    axes = _deterministic_eigen_axes(eigenvalues, eigenvectors, count=2)
    projection = centered @ axes
    if not np.isfinite(projection).all():
        raise ValueError("PCA projection is not finite")
    return projection


def build_topics(
    db_uri: str,
    *,
    topic_count: int = DEFAULT_TOPIC_COUNT,
) -> TopicBuildStats:
    """Rebuild generation-bound topic metadata and 2-D points."""

    if isinstance(topic_count, bool) or not isinstance(topic_count, int) or topic_count <= 0:
        raise ValueError("topic_count must be positive")
    with _semantic_build_lock(db_uri):
        db = connect_db(db_uri)
        manifest = _read_generation_manifest(db_uri)
        if manifest is None or manifest["semantic_generation"] is None:
            raise FileNotFoundError(_GENERATION_MANIFEST)
        generation = manifest["semantic_generation"]
        if SEMANTIC_CHUNKS_TABLE not in db.list_tables().tables:
            raise FileNotFoundError(SEMANTIC_CHUNKS_TABLE)
        if not _published_table_matches(
            db,
            SEMANTIC_CHUNKS_TABLE,
            SemanticChunk,
            generation,
            manifest["chunks"],
        ):
            raise ValueError("semantic generation is incomplete")
        table = db.open_table(SEMANTIC_CHUNKS_TABLE)
        count = table.count_rows()
        if not count:
            raise ValueError("semantic index is empty")
        rows = (
            table.search()
            .where(_vector_space_filter(generation))
            .select(
                [
                    "record_id",
                    "vector",
                    "lexical_text",
                    "vector_space_id",
                    "semantic_generation",
                ]
            )
            .limit(count)
            .to_arrow()
            .to_pylist()
        )
        if len(rows) != manifest["chunks"]:
            raise ValueError("semantic generation is incomplete")
        vector_spaces = {row["vector_space_id"] for row in rows}
        generations = {row["semantic_generation"] for row in rows}
        if vector_spaces != {E5_VECTOR_SPACE_ID} or generations != {generation}:
            raise ValueError("semantic chunks contain mixed vector spaces")

        _write_generation_manifest(
            db_uri,
            semantic_generation=generation,
            chunks=len(rows),
            topics_generation=None,
            topics=0,
            topic_points=0,
            topic_version=None,
        )
        grouped_vectors: dict[str, list[list[float]]] = defaultdict(list)
        grouped_lexical: dict[str, list[str]] = defaultdict(list)
        for row in rows:
            grouped_vectors[row["record_id"]].append(row["vector"])
            grouped_lexical[row["record_id"]].append(row["lexical_text"])
        record_ids = sorted(grouped_vectors)
        keyword_tokens = {
            record_id: _keyword_tokens(grouped_lexical[record_id])
            for record_id in record_ids
        }
        global_keyword_counts: Counter[str] = Counter()
        for tokens in keyword_tokens.values():
            global_keyword_counts.update(tokens)
        matrix = np.asarray(
            [
                normalize_vector(np.asarray(grouped_vectors[record_id]).mean(axis=0))
                for record_id in record_ids
            ],
            dtype=np.float64,
        )
        unique_vectors = np.unique(np.round(matrix, decimals=7), axis=0).shape[0]
        effective_k = min(topic_count, len(record_ids), int(unique_vectors))
        labels, centroids = spherical_kmeans(matrix, k=effective_k, seed=0)
        coordinates = project_pca(matrix)
        topic_version = (
            f"{TOPIC_ALGORITHM_VERSION}:{generation}:k={effective_k}"
        )

        topic_rows: list[dict[str, Any]] = []
        point_rows: list[dict[str, Any]] = []
        for cluster in range(effective_k):
            member_indices = np.flatnonzero(labels == cluster)
            similarities = matrix[member_indices] @ centroids[cluster]
            ordered_local = sorted(
                range(len(member_indices)),
                key=lambda index: (
                    -float(similarities[index]),
                    record_ids[int(member_indices[index])],
                ),
            )
            ordered_indices = [int(member_indices[index]) for index in ordered_local]
            member_ids = [record_ids[index] for index in ordered_indices]
            keywords = _topic_keywords(
                member_ids, keyword_tokens, global_keyword_counts
            )
            topic_id = hashlib.sha256(
                f"{topic_version}\0{cluster}".encode()
            ).hexdigest()
            label = f"Topic {cluster + 1:02d}"
            if keywords:
                label = f"{label} · {' · '.join(keywords[:2])}"
            topic_rows.append(
                {
                    "topic_id": topic_id,
                    "topic_version": topic_version,
                    "label": label,
                    "size": len(member_ids),
                    "keywords": keywords,
                    "centroid": centroids[cluster].astype(np.float32).tolist(),
                    "exemplar_record_ids": member_ids[:3],
                    "semantic_generation": generation,
                }
            )
            for index in ordered_indices:
                point_rows.append(
                    {
                        "record_id": record_ids[index],
                        "topic_id": topic_id,
                        "topic_version": topic_version,
                        "x": float(coordinates[index, 0]),
                        "y": float(coordinates[index, 1]),
                        "distance": float(
                            1.0 - matrix[index] @ centroids[cluster]
                        ),
                        "semantic_generation": generation,
                    }
                )

        topics_stage = f"{SEMANTIC_TOPICS_TABLE}__staging_{generation[:12]}"
        points_stage = f"{SEMANTIC_TOPIC_POINTS_TABLE}__staging_{generation[:12]}"
        _drop_other_stages(db, SEMANTIC_TOPICS_TABLE, topics_stage)
        _drop_other_stages(db, SEMANTIC_TOPIC_POINTS_TABLE, points_stage)
        _write_stage_table(db, topics_stage, SemanticTopic, topic_rows)
        _write_stage_table(db, points_stage, SemanticTopicPoint, point_rows)
        _swap_table(db_uri, topics_stage, SEMANTIC_TOPICS_TABLE)
        _swap_table(db_uri, points_stage, SEMANTIC_TOPIC_POINTS_TABLE)
        published = connect_db(db_uri)
        if not _published_table_matches(
            published,
            SEMANTIC_TOPICS_TABLE,
            SemanticTopic,
            generation,
            len(topic_rows),
            topic_version=topic_version,
        ) or not _published_table_matches(
            published,
            SEMANTIC_TOPIC_POINTS_TABLE,
            SemanticTopicPoint,
            generation,
            len(point_rows),
            topic_version=topic_version,
        ):
            raise RuntimeError("topic publication is incomplete")
        _write_generation_manifest(
            db_uri,
            semantic_generation=generation,
            chunks=len(rows),
            topics_generation=generation,
            topics=len(topic_rows),
            topic_points=len(point_rows),
            topic_version=topic_version,
        )
        return TopicBuildStats(
            records_clustered=len(record_ids),
            topics_written=len(topic_rows),
            points_written=len(point_rows),
            topic_version=topic_version,
            semantic_generation=generation,
        )


def semantic_stats(db_uri: str) -> dict[str, Any]:
    """Return aggregate-only readiness metadata for CLI and Studio."""

    db = connect_db(db_uri)
    names = set(db.list_tables().tables)
    manifest = _read_generation_manifest(db_uri)
    generation = manifest["semantic_generation"] if manifest is not None else None
    chunks = 0
    if (
        manifest is not None
        and isinstance(generation, str)
        and _published_table_matches(
            db,
            SEMANTIC_CHUNKS_TABLE,
            SemanticChunk,
            generation,
            manifest["chunks"],
        )
    ):
        chunks = manifest["chunks"]
    topics_ready = False
    if (
        chunks
        and manifest is not None
        and isinstance(generation, str)
        and manifest["topics_generation"] == generation
        and {SEMANTIC_TOPICS_TABLE, SEMANTIC_TOPIC_POINTS_TABLE} <= names
    ):
        topics_ready = _published_table_matches(
            db,
            SEMANTIC_TOPICS_TABLE,
            SemanticTopic,
            generation,
            manifest["topics"],
            topic_version=manifest["topic_version"],
        ) and _published_table_matches(
            db,
            SEMANTIC_TOPIC_POINTS_TABLE,
            SemanticTopicPoint,
            generation,
            manifest["topic_points"],
            topic_version=manifest["topic_version"],
        )
    topics = (
        db.open_table(SEMANTIC_TOPICS_TABLE).count_rows() if topics_ready else 0
    )
    points = (
        db.open_table(SEMANTIC_TOPIC_POINTS_TABLE).count_rows()
        if topics_ready
        else 0
    )
    if manifest and (topics != manifest["topics"] or points != manifest["topic_points"]):
        topics = 0
        points = 0
    return {
        "ready": chunks > 0,
        "vector_space_id": E5_VECTOR_SPACE_ID,
        "chunks": chunks,
        "topics": topics,
        "topic_points": points,
        "semantic_generation": generation if chunks else None,
    }


def _chunk_rows(
    record: Mapping[str, Any], decoded_chunks: Sequence[str]
) -> Iterable[dict[str, Any]]:
    count = len(decoded_chunks)
    source_hash = str(record.get("text_hash") or "")
    tokenizer_id = lexical_tokenizer_id()
    for index, text in enumerate(decoded_chunks):
        normalized = unicodedata.normalize("NFC", text).strip()
        search_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        yield {
            "chunk_id": make_chunk_id(
                str(record["record_id"]), index, source_hash
            ),
            "record_id": str(record["record_id"]),
            "chunk_index": index,
            "chunk_count": count,
            "record_type": str(record["record_type"]),
            "parent_id": record.get("parent_id"),
            "thread_id": record.get("thread_id"),
            "event_time_ms": record.get("event_time_ms"),
            "source_category": str(record["source_category"]),
            "source_text_hash": source_hash,
            "search_text": normalized,
            "lexical_text": prepare_lexical_text(normalized),
            "lexical_tokenizer_id": tokenizer_id,
            "search_text_hash": search_hash,
            "vector_space_id": E5_VECTOR_SPACE_ID,
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "document_prefix": DOCUMENT_PREFIX,
            "query_prefix": QUERY_PREFIX,
            "pooling": "attention-mask-mean",
            "normalization": "l2",
            "distance_metric": "cosine",
            "chunk_policy_version": CHUNK_POLICY_VERSION,
            "text_transform_version": str(record["text_transform_version"]),
        }


def _normalized_matrix(
    vectors: Sequence[Sequence[float]] | np.ndarray,
) -> np.ndarray:
    matrix = np.asarray(vectors, dtype=np.float64)
    if matrix.ndim != 2 or not matrix.shape[0] or not matrix.shape[1]:
        raise ValueError("vectors must be a non-empty matrix")
    if not np.isfinite(matrix).all():
        raise ValueError("vectors must be finite")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if bool(np.any(norms <= 0)) or not np.isfinite(norms).all():
        raise ValueError("vectors must have positive finite norms")
    return matrix / norms


def _fts_record_hits(
    table: Any,
    query: MatchQuery,
    generation: str,
    candidate_limit: int,
) -> list[dict[str, Any]]:
    rows = (
        table.search(query, query_type="fts")
        .where(_vector_space_filter(generation))
        .select(
            [
                "record_id",
                "chunk_id",
                "chunk_index",
                "record_type",
                "_score",
            ]
        )
        .limit(candidate_limit)
        .to_arrow()
        .to_pylist()
    )
    hits: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        record_id = row["record_id"]
        score = float(row["_score"])
        if record_id in seen or not math.isfinite(score):
            continue
        seen.add(record_id)
        hits.append(row)
    return hits


def _vector_space_filter(generation: str) -> str:
    return (
        f"semantic_generation = '{generation}' AND "
        f"vector_space_id = '{E5_VECTOR_SPACE_ID}'"
    )


def _topic_keywords(
    member_ids: Sequence[str],
    keyword_tokens: Mapping[str, set[str]],
    global_counts: Mapping[str, int],
) -> list[str]:
    counts: Counter[str] = Counter()
    for record_id in member_ids:
        counts.update(keyword_tokens[record_id])
    cluster_size = max(len(member_ids), 1)
    corpus_size = max(len(keyword_tokens), 1)
    ranked = sorted(
        counts,
        key=lambda token: (
            -(
                counts[token]
                / cluster_size
                * math.log((corpus_size + 1) / (global_counts[token] + 1))
            ),
            -counts[token],
            token,
        ),
    )
    return ranked[:5]


def _keyword_tokens(lexical_values: Sequence[str]) -> set[str]:
    tokens: set[str] = set()
    for lexical in lexical_values:
        for token in lexical.split():
            folded = token.casefold()
            if (
                len(folded) >= 2
                and not folded.isdigit()
                and folded not in _GENERIC_STOP_WORDS
                and all(
                    unicodedata.category(character)[0] in {"L", "M", "N"}
                    for character in folded
                )
            ):
                tokens.add(folded)
    return tokens


def _deterministic_eigen_axes(
    eigenvalues: np.ndarray,
    eigenvectors: np.ndarray,
    *,
    count: int,
) -> np.ndarray:
    order = np.argsort(eigenvalues, kind="stable")[::-1]
    ordered_values = eigenvalues[order]
    ordered_vectors = eigenvectors[:, order]
    axes: list[np.ndarray] = []
    start = 0
    scale = max(float(np.max(np.abs(ordered_values))), 1.0)
    tie_tolerance = scale * 1e-10
    while start < len(ordered_values) and len(axes) < count:
        end = start + 1
        while end < len(ordered_values) and math.isclose(
            float(ordered_values[start]),
            float(ordered_values[end]),
            rel_tol=1e-10,
            abs_tol=tie_tolerance,
        ):
            end += 1
        space = ordered_vectors[:, start:end]
        projector = space @ space.T
        group_axes = 0
        for feature in range(projector.shape[0]):
            candidate = projector[:, feature].copy()
            for axis in axes:
                candidate -= float(candidate @ axis) * axis
            norm = float(np.linalg.norm(candidate))
            if norm <= 1e-10:
                continue
            candidate /= norm
            pivot = int(np.argmax(np.abs(candidate)))
            if candidate[pivot] < 0:
                candidate *= -1
            axes.append(candidate)
            group_axes += 1
            if len(axes) == count or group_axes == end - start:
                break
        start = end
    if not axes:
        return np.zeros((eigenvectors.shape[0], count), dtype=np.float64)
    result = np.column_stack(axes[:count])
    if result.shape[1] < count:
        result = np.pad(result, ((0, 0), (0, count - result.shape[1])))
    return result


def _canonical_rows(table: Any) -> list[dict[str, Any]]:
    columns = [
        "record_id",
        "record_type",
        "parent_id",
        "thread_id",
        "event_time_ms",
        "source_category",
        "text",
        "text_hash",
        "text_transform_version",
    ]
    count = table.count_rows()
    if not count:
        return []
    rows = (
        table.search().select(columns).limit(count).to_arrow().to_pylist()
    )
    # Older imports could contain the same stable record key twice when Meta
    # repeated a message across split JSON members. Pick a deterministic
    # representative so derived chunks remain one-per-canonical identity.
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        record_id = str(row["record_id"])
        previous = unique.get(record_id)
        if previous is None or _canonical_json(row) < _canonical_json(previous):
            unique[record_id] = row
    return list(unique.values())


def _canonical_generation(
    records: Sequence[Mapping[str, Any]],
    *,
    max_tokens: int,
    overlap: int,
    tokenizer_id: str,
) -> str:
    digest = hashlib.sha256()
    policy = {
        "chunk_policy_version": CHUNK_POLICY_VERSION,
        "document_prefix": DOCUMENT_PREFIX,
        "lexical_tokenizer_id": tokenizer_id,
        "max_tokens": max_tokens,
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "overlap": overlap,
        "query_prefix": QUERY_PREFIX,
        "vector_space_id": E5_VECTOR_SPACE_ID,
    }
    digest.update(_canonical_json(policy))
    digest.update(b"\n")
    for record in sorted(records, key=lambda item: str(item["record_id"])):
        record_id = str(record["record_id"])
        text = record.get("text")
        if text is not None and not isinstance(text, str):
            raise ValueError("canonical text must be a string or null")
        material = {
            "event_time_ms": record.get("event_time_ms"),
            "parent_id": record.get("parent_id"),
            "record_id": record_id,
            "record_type": record.get("record_type"),
            "source_category": record.get("source_category"),
            "stored_text_hash": record.get("text_hash"),
            "text_sha256": hashlib.sha256((text or "").encode("utf-8")).hexdigest(),
            "text_transform_version": record.get("text_transform_version"),
            "thread_id": record.get("thread_id"),
        }
        digest.update(_canonical_json(material))
        digest.update(b"\n")
    return digest.hexdigest()


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _read_generation_manifest(db_uri: str) -> dict[str, Any] | None:
    path = _local_db_root(db_uri) / _GENERATION_MANIFEST
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("semantic generation manifest path is invalid")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("semantic generation manifest is invalid") from error
    _validate_generation_manifest(value)
    return value


def _write_generation_manifest(
    db_uri: str,
    *,
    semantic_generation: str | None,
    chunks: int,
    topics_generation: str | None,
    topics: int,
    topic_points: int,
    topic_version: str | None,
) -> None:
    root = _local_db_root(db_uri)
    target = root / _GENERATION_MANIFEST
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    else:
        if target.is_symlink() or not target.is_file():
            raise RuntimeError("semantic generation manifest path is invalid")
    value = {
        "version": _GENERATION_MANIFEST_VERSION,
        "vector_space_id": E5_VECTOR_SPACE_ID,
        "semantic_generation": semantic_generation,
        "chunks": chunks,
        "topics_generation": topics_generation,
        "topics": topics,
        "topic_points": topic_points,
        "topic_version": topic_version,
    }
    _validate_generation_manifest(value)
    temporary = root / f".{_GENERATION_MANIFEST}.{os.getpid()}.{os.urandom(8).hex()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _validate_generation_manifest(value: Any) -> None:
    keys = {
        "version",
        "vector_space_id",
        "semantic_generation",
        "chunks",
        "topics_generation",
        "topics",
        "topic_points",
        "topic_version",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise RuntimeError("semantic generation manifest is invalid")
    if (
        value["version"] != _GENERATION_MANIFEST_VERSION
        or value["vector_space_id"] != E5_VECTOR_SPACE_ID
    ):
        raise RuntimeError("semantic generation manifest is incompatible")
    for key in ("semantic_generation", "topics_generation"):
        generation = value[key]
        if generation is not None and not re.fullmatch(r"[0-9a-f]{64}", generation):
            raise RuntimeError("semantic generation manifest is invalid")
    for key in ("chunks", "topics", "topic_points"):
        count = value[key]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise RuntimeError("semantic generation manifest is invalid")
    if value["semantic_generation"] is None and value["chunks"] != 0:
        raise RuntimeError("semantic generation manifest is inconsistent")
    if value["topics_generation"] is None:
        if value["topics"] or value["topic_points"] or value["topic_version"] is not None:
            raise RuntimeError("semantic generation manifest is inconsistent")
    elif (
        value["topics_generation"] != value["semantic_generation"]
        or not isinstance(value["topic_version"], str)
        or not value["topic_version"]
    ):
        raise RuntimeError("semantic generation manifest is inconsistent")


def _published_table_matches(
    db: Any,
    name: str,
    schema: type[LanceModel],
    generation: str,
    expected_count: int,
    *,
    topic_version: str | None = None,
) -> bool:
    if name not in db.list_tables().tables:
        return False
    table = db.open_table(name)
    if not _table_schema(table).equals(schema.to_arrow_schema(), check_metadata=False):
        return False
    if table.count_rows() != expected_count:
        return False
    if schema is SemanticChunk and expected_count:
        indexes = {
            (index.name, tuple(index.columns), index.index_type)
            for index in table.list_indices()
        }
        if not {
            ("search_text_ngrams", ("search_text",), "FTS"),
            ("lexical_text_words", ("lexical_text",), "FTS"),
        } <= indexes:
            return False
    if not expected_count:
        return True
    columns = ["semantic_generation"]
    if schema is SemanticChunk:
        columns.append("vector_space_id")
    if topic_version is not None:
        if "topic_version" not in _table_schema(table).names:
            return False
        columns.append("topic_version")
    rows = (
        table.search()
        .select(columns)
        .limit(expected_count)
        .to_arrow()
        .to_pylist()
    )
    return len(rows) == expected_count and all(
        row["semantic_generation"] == generation
        and (
            schema is not SemanticChunk
            or row["vector_space_id"] == E5_VECTOR_SPACE_ID
        )
        and (topic_version is None or row["topic_version"] == topic_version)
        for row in rows
    )


def _drop_other_stages(db: Any, name: str, keep: str) -> None:
    prefix = f"{name}__staging"
    for candidate in list(db.list_tables().tables):
        if candidate != keep and (
            candidate == prefix or candidate.startswith(f"{prefix}_")
        ):
            _drop_table(db, candidate)


def _open_resumable_stage(
    db: Any,
    stage_name: str,
    schema: type[LanceModel],
    generation: str,
    expected_ids: set[str],
) -> tuple[Any, set[str]]:
    if stage_name not in db.list_tables().tables:
        return db.create_table(stage_name, schema=schema), set()
    table = db.open_table(stage_name)
    valid = _table_schema(table).equals(
        schema.to_arrow_schema(), check_metadata=False
    )
    existing_ids: set[str] = set()
    if valid:
        count = table.count_rows()
        rows = (
            table.search()
            .select(["chunk_id", "semantic_generation", "vector_space_id"])
            .limit(count)
            .to_arrow()
            .to_pylist()
            if count
            else []
        )
        existing_ids = {row["chunk_id"] for row in rows}
        valid = (
            len(rows) == len(existing_ids)
            and existing_ids <= expected_ids
            and all(
                row["semantic_generation"] == generation
                and row["vector_space_id"] == E5_VECTOR_SPACE_ID
                for row in rows
            )
        )
    if not valid:
        _drop_table(db, stage_name)
        return db.create_table(stage_name, schema=schema), set()
    return table, existing_ids


def _write_stage_table(
    db: Any,
    stage_name: str,
    schema: type[LanceModel],
    rows: Sequence[Mapping[str, Any]],
) -> None:
    _drop_table(db, stage_name)
    table = db.create_table(stage_name, schema=schema)
    if rows:
        table.add(list(rows))
    if table.count_rows() != len(rows) or not _table_schema(table).equals(
        schema.to_arrow_schema(), check_metadata=False
    ):
        raise RuntimeError("semantic staging table is invalid")


def _swap_table(db_uri: str, stage_name: str, target_name: str) -> None:
    """Atomically swap local Lance table directories.

    LanceDB OSS 0.38 exposes ``rename_table`` but deliberately reports it as
    unsupported.  These derived tables are local-only, so directory renames on
    the same filesystem provide the staging contract without touching records.
    """

    root = _local_db_root(db_uri)
    stage = root / f"{stage_name}.lance"
    target = root / f"{target_name}.lance"
    backup = root / f"{target_name}__backup.lance"
    if not stage.is_dir() or stage.is_symlink():
        raise RuntimeError("semantic staging table is unavailable")
    if backup.exists():
        if backup.is_symlink() or not backup.is_dir():
            raise RuntimeError("semantic backup path is invalid")
        shutil.rmtree(backup)
    had_target = target.exists()
    if had_target:
        if target.is_symlink() or not target.is_dir():
            raise RuntimeError("semantic target path is invalid")
        os.replace(target, backup)
    try:
        os.replace(stage, target)
    except Exception:
        if had_target:
            os.replace(backup, target)
        raise
    if had_target:
        shutil.rmtree(backup)


def _drop_table(db: Any, name: str) -> None:
    db.drop_table(name, ignore_missing=True)


def _table_schema(table: Any) -> Any:
    schema = table.schema
    return schema() if callable(schema) else schema


def _local_db_root(db_uri: str) -> Path:
    if "://" in str(db_uri):
        raise ValueError("semantic table swaps require a local database")
    root = Path(db_uri).resolve(strict=True)
    if not root.is_dir():
        raise FileNotFoundError(db_uri)
    return root


def stats_asdict(stats: SemanticBuildStats | TopicBuildStats) -> dict[str, Any]:
    """Small aggregate serialization helper for the CLI."""

    return asdict(stats)
