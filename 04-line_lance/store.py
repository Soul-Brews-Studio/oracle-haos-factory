"""Import, query, and embed operations for the local LINE LanceDB."""

from __future__ import annotations

import json
import os
import queue
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import lancedb
from lancedb.query import ColumnOrdering

from models import EMBED_MODEL, ImportFile, LineMessage, LineVector, VECTOR_DIM

MESSAGES = "line_messages"
VECTORS = "line_vectors"
FILES = "import_files"
DEFAULT_SOURCE = Path("/opt/Code/github.com/Soul-Brews-Studio/line-timeline-oracle/local/raw")


def connect(db_path: Path):
    db_path.mkdir(parents=True, exist_ok=True)
    return lancedb.connect(str(db_path))


def _table_names(db: Any) -> set[str]:
    return set(db.list_tables().tables)


def _chunks(rows: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def _manifest(db: Any) -> dict[str, dict[str, Any]]:
    if FILES not in _table_names(db):
        return {}
    return {row["path"]: row for row in db.open_table(FILES).to_arrow().to_pylist()}


def _normalize(row: dict[str, Any], source_file: str) -> dict[str, Any]:
    source_id = str(row.get("id") or row.get("rowid") or "")
    import_key = row.get("import_key") or None
    record_key = str(import_key or (f"d1:{source_id}" if source_id else f"page:{source_file}:{row.get('rowid', '')}"))
    return {
        "record_key": record_key,
        "rowid": int(row["rowid"]) if row.get("rowid") is not None else None,
        "source_id": source_id,
        "chat": str(row.get("chat") or ""),
        "sender": str(row.get("sender") or ""),
        "text": str(row.get("text") or ""),
        "type": str(row.get("type") or "message"),
        "sent_at": str(row.get("sent_at") or ""),
        "source": str(row.get("source") or "import"),
        "media_ref": row.get("media_key") or row.get("media_id") or None,
        "import_key": import_key,
        "created_at": str(row.get("created_at") or row.get("sent_at") or ""),
        "source_file": source_file,
    }


def import_pages(db_path: Path, source: Path = DEFAULT_SOURCE) -> dict[str, int]:
    """Upsert changed webhook-relay D1 JSON pages into scalar Lance tables."""
    pages = sorted(source.glob("chat_messages_*.json")) if source.is_dir() else [source]
    if not pages:
        raise FileNotFoundError(f"no chat_messages_*.json pages under {source}")

    db = connect(db_path)
    known = _manifest(db)
    changed: list[Path] = []
    for page in pages:
        stat = page.stat()
        old = known.get(str(page.resolve()))
        if not old or old["mtime_ns"] != stat.st_mtime_ns or old["size"] != stat.st_size:
            changed.append(page)

    imported = 0
    file_rows: list[dict[str, Any]] = []
    for page in changed:
        raw = json.loads(page.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError(f"expected a JSON row list in {page}")
        rows = [_normalize(row, str(page.resolve())) for row in raw]
        if rows:
            if MESSAGES not in _table_names(db):
                db.create_table(MESSAGES, schema=LineMessage).add(rows)
            else:
                table = db.open_table(MESSAGES)
                for chunk in _chunks(rows, 1000):
                    (table.merge_insert("record_key")
                        .when_matched_update_all()
                        .when_not_matched_insert_all()
                        .execute(chunk))
            imported += len(rows)
        stat = page.stat()
        file_rows.append({
            "path": str(page.resolve()),
            "mtime_ns": stat.st_mtime_ns,
            "size": stat.st_size,
            "rows": len(rows),
            "imported_at": datetime.now(timezone.utc).isoformat(),
        })

    if file_rows:
        if FILES not in _table_names(db):
            db.create_table(FILES, schema=ImportFile).add(file_rows)
        else:
            (db.open_table(FILES).merge_insert("path")
                .when_matched_update_all()
                .when_not_matched_insert_all()
                .execute(file_rows))

    total = db.open_table(MESSAGES).count_rows() if MESSAGES in _table_names(db) else 0
    return {"pages": len(pages), "changed": len(changed), "upserted": imported, "total": total}


def stats(db_path: Path) -> dict[str, Any]:
    db = connect(db_path)
    names = _table_names(db)
    if MESSAGES not in names:
        return {"messages": 0, "chats": 0, "vectors": 0, "files": 0, "types": {}, "sources": {}, "first": None, "last": None}
    rows = db.open_table(MESSAGES).search().select(["chat", "type", "source", "sent_at"]).to_list()
    types: dict[str, int] = {}
    sources: dict[str, int] = {}
    dates: list[str] = []
    chats: set[str] = set()
    for row in rows:
        chats.add(row["chat"])
        types[row["type"]] = types.get(row["type"], 0) + 1
        sources[row["source"]] = sources.get(row["source"], 0) + 1
        if row["sent_at"]:
            dates.append(row["sent_at"])
    return {
        "messages": len(rows), "chats": len(chats),
        "vectors": db.open_table(VECTORS).count_rows() if VECTORS in names else 0,
        "files": db.open_table(FILES).count_rows() if FILES in names else 0,
        "types": dict(sorted(types.items(), key=lambda item: (-item[1], item[0]))),
        "sources": sources, "first": min(dates) if dates else None, "last": max(dates) if dates else None,
    }


def list_messages(
    db_path: Path, *, q: str = "", chat: str = "", exact_chat: str = "", kind: str = "",
    day: str = "", media_only: bool = False, limit: int = 50, offset: int = 0
) -> dict[str, Any]:
    db = connect(db_path)
    if MESSAGES not in _table_names(db):
        return {"messages": [], "count": 0, "offset": 0}
    predicates: list[str] = []
    for column, value in (("text", q), ("chat", chat), ("type", kind)):
        if value:
            escaped = value.lower().replace("'", "''")
            predicates.append(f"lower({column}) LIKE '%{escaped}%'")
    if exact_chat:
        escaped = exact_chat.replace("'", "''")
        predicates.append(f"chat = '{escaped}'")
    if day:
        escaped = day.replace("'", "''")
        predicates.append(f"sent_at >= '{escaped}T00:00:00' AND sent_at < '{escaped}T23:59:59.999999Z'")
    if media_only:
        predicates.append("type IN ('image', 'photo', 'video', 'audio', 'file')")
    where = " AND ".join(predicates) if predicates else None
    query = db.open_table(MESSAGES).search()
    if where:
        query = query.where(where)
    rows = (query.order_by([ColumnOrdering(column_name="sent_at", ascending=False)]).select([
        "record_key", "source_id", "chat", "sender", "text", "type", "sent_at", "source", "media_ref"
    ]).offset(max(offset, 0)).limit(max(1, min(limit, 200))).to_list())
    total = db.open_table(MESSAGES).count_rows(where)
    return {"messages": rows, "count": len(rows), "total": total, "offset": max(offset, 0)}


def chat_summaries(db_path: Path) -> list[dict[str, Any]]:
    """Return one newest-first aggregate row per LINE chat."""
    db = connect(db_path)
    if MESSAGES not in _table_names(db):
        return []
    rows = db.open_table(MESSAGES).search().select(["chat", "sender", "text", "sent_at", "source"]).to_list()
    chats: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row["chat"] or "Unknown chat"
        current = chats.setdefault(name, {
            "chat": name, "messages": 0, "webhook": 0, "imported": 0,
            "last_at": "", "last_sender": "", "last_text": "",
        })
        current["messages"] += 1
        current["webhook" if row["source"] == "webhook" else "imported"] += 1
        if row["sent_at"] > current["last_at"]:
            current["last_at"] = row["sent_at"]
            current["last_sender"] = row["sender"]
            current["last_text"] = row["text"][:160]
    return sorted(chats.values(), key=lambda row: (-row["messages"], row["chat"].lower()))


def table_info(db_path: Path) -> list[dict[str, Any]]:
    """Expose honest Lance table/schema state for the settings screen."""
    db = connect(db_path)
    output: list[dict[str, Any]] = []
    for name in sorted(_table_names(db)):
        table = db.open_table(name)
        output.append({
            "name": name,
            "rows": table.count_rows(),
            "columns": [{"name": field.name, "type": str(field.type)} for field in table.schema],
        })
    return output


def _embed_url(url: str, texts: list[str]) -> list[list[float]]:
    """Call either the local CF adapter ({texts}) or Workers AI REST ({text})."""
    is_workers_ai = "/ai/run/" in url
    body = {"text" if is_workers_ai else "texts": texts}
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("CF_API_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode())
    data = payload.get("result", {}).get("data") if is_workers_ai else payload.get("data")
    if not isinstance(data, list) or len(data) != len(texts):
        raise ValueError(f"embedder returned {len(data) if isinstance(data, list) else 'invalid'} vectors for {len(texts)} texts")
    if data and len(data[0]) != VECTOR_DIM:
        raise ValueError(f"expected {VECTOR_DIM}-dim BGE-M3 vectors, got {len(data[0])}")
    return data


def _embed_urls() -> list[str]:
    configured = [url.strip() for url in os.environ.get("EMBED_URLS", "").split(",") if url.strip()]
    if configured:
        return configured
    account = os.environ.get("CF_ACCOUNT_ID")
    if account:
        return [f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{EMBED_MODEL}"]
    raise RuntimeError("set EMBED_URLS for a local CF adapter, or CF_ACCOUNT_ID + CF_API_TOKEN for Workers AI REST")


def embed_messages(db_path: Path, limit: int = 1000) -> dict[str, Any]:
    """Embed eligible rows with endpoint work-stealing and incremental Lance flushes."""
    db = connect(db_path)
    if MESSAGES not in _table_names(db):
        raise FileNotFoundError("line_messages is missing; run import first")
    existing: set[str] = set()
    if VECTORS in _table_names(db):
        existing = {row["record_key"] for row in db.open_table(VECTORS).search().select(["record_key"]).to_list()}
    candidates = db.open_table(MESSAGES).search().select([
        "record_key", "source_id", "chat", "sender", "text", "type", "sent_at"
    ]).to_list()
    todo = [row for row in candidates if row["record_key"] not in existing and row["type"] in {"text", "message"} and len(row["text"].strip()) >= 8][:limit]
    if not todo:
        return {"eligible": len(candidates), "embedded": 0, "total_vectors": len(existing)}

    batches = list(_chunks(todo, 20))
    urls = _embed_urls()
    work: queue.Queue[tuple[int, list[dict[str, Any]]]] = queue.Queue()
    for index, batch in enumerate(batches):
        work.put((index, batch))
    write_lock = threading.Lock()
    failures: list[str] = []
    written = 0

    def worker(url: str) -> int:
        """Fast endpoints keep taking the next shared batch; a dead endpoint retires."""
        nonlocal written
        local_written = 0
        while True:
            try:
                item = work.get_nowait()
            except queue.Empty:
                return local_written
            _index, batch = item
            try:
                texts = [f"[{row['chat']}] {row['sender']}: {row['text'][:3000]}" for row in batch]
                vectors = _embed_url(url, texts)
                rows = [{
                    "record_key": row["record_key"], "source_id": row["source_id"], "chat": row["chat"],
                    "sender": row["sender"], "text": row["text"][:500], "sent_at": row["sent_at"],
                    "model": EMBED_MODEL, "vector": vector,
                } for row, vector in zip(batch, vectors)]
                # Lance writes are serialized and flushed per batch. A later failure cannot
                # erase vectors that an earlier endpoint already paid to compute.
                with write_lock:
                    if VECTORS not in _table_names(db):
                        db.create_table(VECTORS, schema=LineVector).add(rows)
                    else:
                        (db.open_table(VECTORS).merge_insert("record_key")
                            .when_matched_update_all().when_not_matched_insert_all().execute(rows))
                    written += len(rows)
                local_written += len(rows)
            except Exception as error:
                # Return this batch for a surviving endpoint, then retire the failed worker.
                work.put(item)
                failures.append(f"{url}: {error}")
                return local_written
            finally:
                work.task_done()

    with ThreadPoolExecutor(max_workers=len(urls)) as pool:
        for future in [pool.submit(worker, url) for url in urls]:
            future.result()
    if not work.empty():
        detail = "; ".join(failures) or "no endpoint completed the remaining batches"
        raise RuntimeError(f"embedding stopped with {work.qsize()} batches pending after flushing {written} rows: {detail}")
    return {"eligible": len(candidates), "embedded": written, "total_vectors": len(existing) + written}


def semantic_search(db_path: Path, query: str, limit: int = 20) -> list[dict[str, Any]]:
    db = connect(db_path)
    if VECTORS not in _table_names(db):
        raise FileNotFoundError("line_vectors is missing; run embed first")
    vector = _embed_url(_embed_urls()[0], [query])[0]
    return db.open_table(VECTORS).search(vector).limit(max(1, min(limit, 50))).to_list()
