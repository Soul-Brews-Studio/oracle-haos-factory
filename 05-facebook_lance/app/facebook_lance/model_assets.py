"""Fetch the immutable E5 ONNX snapshot and write a verified local manifest."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .embeddings import (
    MODEL_FILE_PATH,
    MODEL_FILE_SHA256,
    MODEL_FILE_SIZE,
    MODEL_ID,
    MODEL_MANIFEST,
    MODEL_REVISION,
    TOKENIZER_FILE_PATH,
    TOKENIZER_FILE_SHA256,
    TOKENIZER_FILE_SIZE,
    VECTOR_DIMENSION,
    EmbeddingUnavailable,
    verify_model_manifest,
)

_DOWNLOAD_BUFFER_BYTES = 1024 * 1024
_USER_AGENT = "facebook-lance/0.1 immutable-model-fetch"


@dataclass(frozen=True)
class ModelFileSpec:
    logical_name: str
    relative_path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class ModelFetchStats:
    files: int
    bytes: int
    downloaded_files: int
    model_id: str
    revision: str


MODEL_FILES = (
    ModelFileSpec(
        logical_name="model",
        relative_path=MODEL_FILE_PATH,
        sha256=MODEL_FILE_SHA256,
        size=MODEL_FILE_SIZE,
    ),
    ModelFileSpec(
        logical_name="tokenizer",
        relative_path=TOKENIZER_FILE_PATH,
        sha256=TOKENIZER_FILE_SHA256,
        size=TOKENIZER_FILE_SIZE,
    ),
)


def fetch_model_snapshot(model_dir: str | Path) -> ModelFetchStats:
    """Download only the pinned model/tokenizer, verify, then publish a manifest."""

    requested_root = Path(model_dir)
    requested_root.mkdir(parents=True, exist_ok=True)
    if requested_root.is_symlink() or not requested_root.is_dir():
        raise EmbeddingUnavailable("model directory is invalid")
    try:
        root = requested_root.resolve(strict=True)
    except OSError as error:
        raise EmbeddingUnavailable("model directory is invalid") from error
    downloaded = 0
    for spec in MODEL_FILES:
        target = root / spec.relative_path
        _safe_parent(root, Path(spec.relative_path).parent)
        if _file_matches(target, spec):
            continue
        _download_file(spec, target)
        downloaded += 1

    manifest = {
        "model_id": MODEL_ID,
        "revision": MODEL_REVISION,
        "vector_dimension": VECTOR_DIMENSION,
        "files": {
            spec.logical_name: {
                "path": spec.relative_path,
                "sha256": spec.sha256,
            }
            for spec in MODEL_FILES
        },
    }
    manifest_path = root / MODEL_MANIFEST
    temporary = root / f".{MODEL_MANIFEST}.part"
    _write_exclusive(
        temporary,
        (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode(),
    )
    os.replace(temporary, manifest_path)
    verify_model_manifest(root, expected_files=_expected_files())
    return ModelFetchStats(
        files=len(MODEL_FILES),
        bytes=sum(spec.size for spec in MODEL_FILES),
        downloaded_files=downloaded,
        model_id=MODEL_ID,
        revision=MODEL_REVISION,
    )


def model_fetch_asdict(stats: ModelFetchStats) -> dict[str, object]:
    return asdict(stats)


def _download_file(spec: ModelFileSpec, target: Path) -> None:
    temporary = target.with_name(f".{target.name}.part")
    temporary.unlink(missing_ok=True)
    remote_path = "/".join(
        part.replace(" ", "%20") for part in spec.relative_path.split("/")
    )
    url = (
        f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/"
        f"{remote_path}?download=true"
    )
    request = Request(url, headers={"User-Agent": _USER_AGENT})
    digest = hashlib.sha256()
    size = 0
    try:
        with urlopen(request, timeout=120) as response:
            descriptor = _open_exclusive(temporary)
            with os.fdopen(descriptor, "wb") as stream:
                while True:
                    block = response.read(_DOWNLOAD_BUFFER_BYTES)
                    if not block:
                        break
                    size += len(block)
                    if size > spec.size:
                        raise EmbeddingUnavailable(
                            "model download exceeded expected size"
                        )
                    digest.update(block)
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
    except EmbeddingUnavailable:
        temporary.unlink(missing_ok=True)
        raise
    except (HTTPError, URLError, OSError, TimeoutError) as error:
        temporary.unlink(missing_ok=True)
        raise EmbeddingUnavailable("model download failed") from error
    if size != spec.size or digest.hexdigest() != spec.sha256:
        temporary.unlink(missing_ok=True)
        raise EmbeddingUnavailable("model download checksum mismatch")
    os.replace(temporary, target)


def _file_matches(path: Path, spec: ModelFileSpec) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    try:
        if path.stat().st_size != spec.size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(_DOWNLOAD_BUFFER_BYTES), b""):
                digest.update(block)
        return digest.hexdigest() == spec.sha256
    except OSError:
        return False


def _safe_parent(root: Path, relative: Path) -> Path:
    current = root
    for part in relative.parts:
        if part in {"", ".", ".."}:
            raise EmbeddingUnavailable("model file path is invalid")
        current = current / part
        try:
            current.mkdir(mode=0o700, exist_ok=True)
        except OSError as error:
            raise EmbeddingUnavailable("model directory is unavailable") from error
        if current.is_symlink() or not current.is_dir():
            raise EmbeddingUnavailable("model directory is invalid")
        try:
            current.resolve(strict=True).relative_to(root)
        except (OSError, ValueError) as error:
            raise EmbeddingUnavailable("model directory is invalid") from error
    return current


def _open_exclusive(path: Path) -> int:
    path.unlink(missing_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        return os.open(path, flags, 0o600)
    except OSError as error:
        raise EmbeddingUnavailable("model temporary file is unavailable") from error


def _write_exclusive(path: Path, content: bytes) -> None:
    descriptor = _open_exclusive(path)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        path.unlink(missing_ok=True)
        raise EmbeddingUnavailable("model manifest could not be written") from error


def _expected_files() -> dict[str, tuple[str, str, int]]:
    return {
        spec.logical_name: (spec.relative_path, spec.sha256, spec.size)
        for spec in MODEL_FILES
    }
