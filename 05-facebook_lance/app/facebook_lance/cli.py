"""Aggregate-only command-line interface."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any
from zipfile import BadZipFile

import pyarrow as pa

from .inventory import inventory_zip
from .normalize import iter_normalized_records
from .store import RECORDS_TABLE, connect_db, import_zip


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="facebook-lance")
    parser.add_argument("--json", action="store_true", help="emit aggregate JSON")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inventory = subparsers.add_parser("inventory", help="inspect ZIP metadata only")
    inventory.add_argument("zip", type=Path)
    _json_after_subcommand(inventory)

    transform = subparsers.add_parser("transform", help="dry-run normalization")
    transform.add_argument("zip", type=Path)
    _json_after_subcommand(transform)

    importer = subparsers.add_parser("import", help="upsert normalized records")
    importer.add_argument("zip", type=Path)
    importer.add_argument("--db", required=True)
    importer.add_argument("--batch-size", type=int, default=500)
    _json_after_subcommand(importer)

    stats = subparsers.add_parser("stats", help="show aggregate table counts")
    stats.add_argument("--db", required=True)
    _json_after_subcommand(stats)

    model_fetch = subparsers.add_parser(
        "semantic-model-fetch", help="fetch the pinned offline embedding model"
    )
    model_fetch.add_argument("--model-dir", required=True, type=Path)
    _json_after_subcommand(model_fetch)

    model_verify = subparsers.add_parser(
        "semantic-model-verify", help="verify the pinned offline model manifest"
    )
    model_verify.add_argument("--model-dir", required=True, type=Path)
    _json_after_subcommand(model_verify)

    semantic_build = subparsers.add_parser(
        "semantic-build", help="rebuild the derived semantic chunk table"
    )
    semantic_build.add_argument("--db", required=True)
    semantic_provider = semantic_build.add_mutually_exclusive_group(required=True)
    semantic_provider.add_argument("--model-dir", type=Path)
    semantic_provider.add_argument("--embed-url")
    semantic_build.add_argument("--tokenizer-file", type=Path)
    semantic_build.add_argument("--batch-size", type=int, default=16)
    _json_after_subcommand(semantic_build)

    rag_build = subparsers.add_parser(
        "rag-build", help="rebuild exact post/comment retrieval membership"
    )
    rag_build.add_argument("--db", required=True)
    _json_after_subcommand(rag_build)

    rag_stats_parser = subparsers.add_parser(
        "rag-stats", help="show aggregate joined-retrieval readiness"
    )
    rag_stats_parser.add_argument("--db", required=True)
    _json_after_subcommand(rag_stats_parser)

    semantic_topics = subparsers.add_parser(
        "semantic-topics", help="rebuild deterministic topic tables"
    )
    semantic_topics.add_argument("--db", required=True)
    semantic_topics.add_argument("--topic-count", type=int, default=24)
    _json_after_subcommand(semantic_topics)

    semantic_stats = subparsers.add_parser(
        "semantic-stats", help="show aggregate derived-index readiness"
    )
    semantic_stats.add_argument("--db", required=True)
    _json_after_subcommand(semantic_stats)

    embed_serve = subparsers.add_parser(
        "embed-serve", help="serve the pinned embedder for trusted local clients"
    )
    embed_serve.add_argument("--model-dir", required=True, type=Path)
    embed_serve.add_argument("--host", default="127.0.0.1")
    embed_serve.add_argument("--port", type=int, default=8792)

    studio = subparsers.add_parser("studio", help="browse records on localhost")
    studio.add_argument("--db", required=True)
    studio.add_argument("--port", type=int, default=8791)
    provider = studio.add_mutually_exclusive_group()
    provider.add_argument("--embed-url")
    provider.add_argument("--model-dir", type=Path)
    studio.add_argument("--embed-timeout", type=float, default=30.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "inventory":
            result = asdict(inventory_zip(args.zip))
        elif args.command == "transform":
            counts: Counter[str] = Counter()
            total = 0
            for record in iter_normalized_records(args.zip):
                total += 1
                counts[record["record_type"]] += 1
            result = {
                "records_seen": total,
                "by_type": dict(sorted(counts.items())),
            }
        elif args.command == "import":
            result = asdict(import_zip(args.zip, args.db, args.batch_size))
            # `export_id` is useful to local callers but is derived partly from
            # private member names. The CLI contract is aggregate counts only.
            result.pop("export_id", None)
        elif args.command == "stats":
            result = _stats(args.db)
        elif args.command == "semantic-model-fetch":
            from .model_assets import fetch_model_snapshot, model_fetch_asdict

            result = model_fetch_asdict(fetch_model_snapshot(args.model_dir))
        elif args.command == "semantic-model-verify":
            from .embeddings import (
                E5_VECTOR_SPACE_ID,
                VECTOR_DIMENSION,
                verify_model_manifest,
            )

            verify_model_manifest(args.model_dir)
            result = {
                "ready": True,
                "dimension": VECTOR_DIMENSION,
                "vector_space_id": E5_VECTOR_SPACE_ID,
            }
        elif args.command == "semantic-build":
            from .embed_service import TOKEN_ENVIRONMENT_VARIABLE
            from .embeddings import (
                LocalOnnxE5Provider,
                RemoteEmbeddingProvider,
                load_verified_tokenizer,
            )
            from .semantic import build_semantic_index, stats_asdict

            tokenizer = None
            if args.embed_url is not None:
                token = os.environ.get(TOKEN_ENVIRONMENT_VARIABLE)
                if not token or args.tokenizer_file is None:
                    raise ValueError(
                        "remote semantic build requires token and tokenizer file"
                    )
                provider = RemoteEmbeddingProvider(args.embed_url, token)
                tokenizer = load_verified_tokenizer(args.tokenizer_file)
            else:
                if args.tokenizer_file is not None:
                    raise ValueError("tokenizer file is only valid with embed URL")
                provider = LocalOnnxE5Provider(args.model_dir)
            result = stats_asdict(
                build_semantic_index(
                    args.db,
                    provider,
                    tokenizer=tokenizer,
                    batch_size=args.batch_size,
                )
            )
        elif args.command == "rag-build":
            from .rag import build_retrieval_documents

            result = asdict(build_retrieval_documents(args.db))
        elif args.command == "rag-stats":
            from .rag import rag_stats

            result = rag_stats(args.db)
        elif args.command == "semantic-topics":
            from .semantic import build_topics, stats_asdict

            result = stats_asdict(build_topics(args.db, topic_count=args.topic_count))
        elif args.command == "semantic-stats":
            from .semantic import semantic_stats

            result = semantic_stats(args.db)
        elif args.command == "embed-serve":
            return _run_embedding_server(args.model_dir, args.host, args.port)
        else:
            return _run_studio(
                args.db,
                args.port,
                embed_url=args.embed_url,
                model_dir=args.model_dir,
                embed_timeout=args.embed_timeout,
            )
    except FileNotFoundError:
        print("error: input or database was not found", file=sys.stderr)
        return 2
    except BadZipFile:
        print("error: input is not a valid ZIP archive", file=sys.stderr)
        return 2
    except (json.JSONDecodeError, UnicodeDecodeError):
        print("error: a selected JSON member is invalid", file=sys.stderr)
        return 2
    except (ValueError, pa.ArrowException) as error:
        # Deliberately omit exception text: schemas and paths can contain private data.
        _ = error
        print("error: validation or schema check failed", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - intentional CLI privacy boundary
        # Native storage exceptions may include private database paths or table
        # metadata. Never allow an unexpected error to reach traceback output.
        _ = error
        print("error: operation failed", file=sys.stderr)
        return 2

    _emit(result, args.json)
    return 0


def _stats(uri: str) -> dict[str, Any]:
    db = connect_db(uri)
    if RECORDS_TABLE not in db.table_names():
        return {"table_rows": 0, "by_type": {}}
    table = db.open_table(RECORDS_TABLE)
    rows = table.count_rows()
    counts: Counter[str] = Counter()
    if rows:
        result = table.search().select(["record_type"]).limit(rows).to_arrow()
        counts.update(result.column("record_type").to_pylist())
    return {"table_rows": rows, "by_type": dict(sorted(counts.items()))}


def _run_studio(
    uri: str,
    port: int,
    *,
    embed_url: str | None,
    model_dir: Path | None,
    embed_timeout: float,
) -> int:
    from .embed_service import TOKEN_ENVIRONMENT_VARIABLE
    from .embeddings import LocalOnnxE5Provider, RemoteEmbeddingProvider
    from .server import create_server

    embedding_provider = None
    if embed_url is not None:
        token = os.environ.get(TOKEN_ENVIRONMENT_VARIABLE)
        if not token:
            raise ValueError(f"{TOKEN_ENVIRONMENT_VARIABLE} is required")
        embedding_provider = RemoteEmbeddingProvider(
            embed_url, token, timeout=embed_timeout
        )
    elif model_dir is not None:
        embedding_provider = LocalOnnxE5Provider(model_dir)
    if embedding_provider is not None:
        embedding_provider.preflight()
    server = create_server(uri, port, embedding_provider)
    actual_port = server.server_address[1]
    print(f"http://127.0.0.1:{actual_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def _run_embedding_server(model_dir: Path, host: str, port: int) -> int:
    from .embed_service import create_embedding_server
    from .embeddings import LocalOnnxE5Provider

    server = create_embedding_server(
        LocalOnnxE5Provider(model_dir), host=host, port=port
    )
    actual_host, actual_port = server.server_address[:2]
    print(f"http://{actual_host}:{actual_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def _json_after_subcommand(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )


def _emit(result: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return
    for key, value in result.items():
        if isinstance(value, dict):
            rendered = json.dumps(value, sort_keys=True, separators=(",", ":"))
        else:
            rendered = value
        print(f"{key}: {rendered}")


if __name__ == "__main__":
    raise SystemExit(main())
