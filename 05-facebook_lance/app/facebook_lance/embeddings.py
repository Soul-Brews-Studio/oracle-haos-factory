"""Pinned multilingual E5 embedding providers with a fixed vector contract."""

from __future__ import annotations

import hashlib
import json
import math
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MODEL_ID = "intfloat/multilingual-e5-small"
MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
VECTOR_DIMENSION = 384
E5_VECTOR_SPACE_ID = (
    f"intfloat/multilingual-e5-small@{MODEL_REVISION}:mean-pooling:l2:384"
)
QUERY_PREFIX = "query: "
DOCUMENT_PREFIX = "passage: "
MAX_TOKEN_LENGTH = 512
MODEL_FILE_PATH = "onnx/model.onnx"
MODEL_FILE_SHA256 = "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"
MODEL_FILE_SIZE = 470_268_510
TOKENIZER_FILE_PATH = "onnx/tokenizer.json"
TOKENIZER_FILE_SHA256 = (
    "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"
)
TOKENIZER_FILE_SIZE = 17_082_730

MODEL_MANIFEST = "manifest.json"
_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_REMOTE_RESPONSE_BYTES = 8 * 1024 * 1024
_HASH_BUFFER_BYTES = 1024 * 1024
_REQUIRED_MODEL_FILES = frozenset({"model", "tokenizer"})

EmbeddingKind = Literal["query", "document"]


class EmbeddingError(Exception):
    """Base class for failures that are safe to classify without data details."""


class InvalidEmbeddingRequest(EmbeddingError):
    """The caller supplied values outside the embedding contract."""


class EmbeddingUnavailable(EmbeddingError):
    """The configured provider could not produce contract-compatible vectors."""


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Provider boundary shared by local indexing and remote query embedding."""

    @property
    def vector_space_id(self) -> str:
        """Return the immutable identity of the produced vector space."""

        ...

    def embed(self, texts: Sequence[str], *, kind: EmbeddingKind) -> list[list[float]]:
        """Embed ordered texts as exactly 384-dimensional normalized vectors."""

        ...

    def preflight(self) -> None:
        """Fail unless the provider can produce its declared vector contract."""

        ...


@dataclass(frozen=True)
class VerifiedModelFiles:
    """Verified local paths for the only files loaded by the ONNX provider."""

    model: Path
    tokenizer: Path


def prefix_text(text: str, kind: EmbeddingKind) -> str:
    """Apply the asymmetric E5 prefix required for retrieval."""

    if kind == "query":
        return f"{QUERY_PREFIX}{text}"
    if kind == "document":
        return f"{DOCUMENT_PREFIX}{text}"
    raise InvalidEmbeddingRequest("kind must be query or document")


def validate_vectors(value: Any, *, expected_count: int) -> list[list[float]]:
    """Validate and copy vectors at the trust boundary."""

    if not isinstance(value, list) or len(value) != expected_count:
        raise EmbeddingUnavailable("embedding response has an invalid count")
    vectors: list[list[float]] = []
    for candidate in value:
        if not isinstance(candidate, list) or len(candidate) != VECTOR_DIMENSION:
            raise EmbeddingUnavailable("embedding response has an invalid dimension")
        vector: list[float] = []
        for component in candidate:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                raise EmbeddingUnavailable("embedding response is not numeric")
            numeric = float(component)
            if not math.isfinite(numeric):
                raise EmbeddingUnavailable("embedding response is not finite")
            vector.append(numeric)
        vectors.append(vector)
    return vectors


def verify_model_manifest(
    model_dir: str | Path,
    *,
    expected_files: Mapping[str, tuple[str, str, int]] | None = None,
) -> VerifiedModelFiles:
    """Verify immutable offline model files against a fail-closed manifest.

    The manifest format is intentionally small::

        {
          "model_id": "intfloat/multilingual-e5-small",
          "revision": "...40 hex characters...",
          "vector_dimension": 384,
          "files": {
            "model": {"path": "onnx/model.onnx", "sha256": "..."},
            "tokenizer": {"path": "tokenizer.json", "sha256": "..."}
          }
        }
    """

    root = Path(model_dir)
    manifest_path = root / MODEL_MANIFEST
    try:
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise EmbeddingUnavailable("model manifest is unavailable")
        raw = manifest_path.read_bytes()
        if len(raw) > _MAX_MANIFEST_BYTES:
            raise EmbeddingUnavailable("model manifest is invalid")
        manifest = json.loads(raw)
    except EmbeddingUnavailable:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EmbeddingUnavailable("model manifest is invalid") from error

    if not isinstance(manifest, dict) or set(manifest) != {
        "model_id",
        "revision",
        "vector_dimension",
        "files",
    }:
        raise EmbeddingUnavailable("model manifest is invalid")
    if (
        manifest["model_id"] != MODEL_ID
        or manifest["revision"] != MODEL_REVISION
        or manifest["vector_dimension"] != VECTOR_DIMENSION
    ):
        raise EmbeddingUnavailable("model manifest does not match the vector space")

    expected = expected_files or {
        "model": (MODEL_FILE_PATH, MODEL_FILE_SHA256, MODEL_FILE_SIZE),
        "tokenizer": (
            TOKENIZER_FILE_PATH,
            TOKENIZER_FILE_SHA256,
            TOKENIZER_FILE_SIZE,
        ),
    }
    entries = manifest["files"]
    if not isinstance(entries, dict) or set(entries) != _REQUIRED_MODEL_FILES:
        raise EmbeddingUnavailable("model manifest files are invalid")
    verified: dict[str, Path] = {}
    try:
        resolved_root = root.resolve(strict=True)
    except OSError as error:
        raise EmbeddingUnavailable("model directory is unavailable") from error

    for logical_name in sorted(_REQUIRED_MODEL_FILES):
        entry = entries[logical_name]
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise EmbeddingUnavailable("model manifest file entry is invalid")
        relative_path = entry["path"]
        expected_hash = entry["sha256"]
        pinned_path, pinned_hash, pinned_size = expected[logical_name]
        if (
            not isinstance(relative_path, str)
            or not relative_path
            or Path(relative_path).is_absolute()
            or not isinstance(expected_hash, str)
            or len(expected_hash) != 64
            or any(character not in "0123456789abcdef" for character in expected_hash)
            or relative_path != pinned_path
            or expected_hash != pinned_hash
        ):
            raise EmbeddingUnavailable("model manifest file entry is invalid")
        candidate = root / relative_path
        try:
            if candidate.is_symlink() or not candidate.is_file():
                raise EmbeddingUnavailable("model file is unavailable")
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(resolved_root)
        except EmbeddingUnavailable:
            raise
        except (OSError, ValueError) as error:
            raise EmbeddingUnavailable(
                "model file is outside the model directory"
            ) from error
        try:
            actual_size = resolved.stat().st_size
        except OSError as error:
            raise EmbeddingUnavailable("model file is unreadable") from error
        if actual_size != pinned_size or _sha256(resolved) != expected_hash:
            raise EmbeddingUnavailable("model file checksum mismatch")
        verified[logical_name] = resolved

    return VerifiedModelFiles(model=verified["model"], tokenizer=verified["tokenizer"])


class LocalOnnxE5Provider:
    """Offline multilingual E5 provider using ONNX mean pooling.

    Model bytes are verified during construction. Heavy optional dependencies and
    inference state are loaded only on the first embed call.
    """

    def __init__(
        self,
        model_dir: str | Path,
        *,
        _expected_files: Mapping[str, tuple[str, str, int]] | None = None,
    ) -> None:
        self._files = verify_model_manifest(model_dir, expected_files=_expected_files)
        self._tokenizer: Any | None = None
        self._session: Any | None = None
        self._numpy: Any | None = None
        self._lock = threading.Lock()

    @property
    def vector_space_id(self) -> str:
        return E5_VECTOR_SPACE_ID

    @property
    def tokenizer(self) -> Any:
        """Return an independent offline tokenizer for token-aware chunking.

        The returned tokenizer has no truncation or padding configuration. Mutating
        it cannot change the provider's private inference tokenizer.
        """

        return self._load_tokenizer()

    def embed(self, texts: Sequence[str], *, kind: EmbeddingKind) -> list[list[float]]:
        materialized = _validate_texts(texts)
        prefixed = [prefix_text(text, kind) for text in materialized]
        with self._lock:
            self._ensure_tokenizer_loaded()
            self._ensure_session_loaded()
            assert self._tokenizer is not None
            assert self._session is not None
            assert self._numpy is not None
            encodings = self._tokenizer.encode_batch(prefixed)
            np = self._numpy
            input_ids = np.asarray([item.ids for item in encodings], dtype=np.int64)
            attention_mask = np.asarray(
                [item.attention_mask for item in encodings], dtype=np.int64
            )
            type_ids = np.asarray([item.type_ids for item in encodings], dtype=np.int64)
            available_inputs = {item.name for item in self._session.get_inputs()}
            inputs: dict[str, Any] = {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
            }
            if "token_type_ids" in available_inputs:
                inputs["token_type_ids"] = type_ids
            if (
                not set(inputs) <= available_inputs
                or not {
                    "input_ids",
                    "attention_mask",
                }
                <= available_inputs
            ):
                raise EmbeddingUnavailable("model inputs do not match the contract")
            outputs = self._session.run(None, inputs)
            if not outputs:
                raise EmbeddingUnavailable("model output is unavailable")
            hidden = np.asarray(outputs[0])
            if (
                hidden.ndim != 3
                or hidden.shape[0] != len(prefixed)
                or hidden.shape[2] != VECTOR_DIMENSION
            ):
                raise EmbeddingUnavailable("model output does not match the contract")
            mask = attention_mask.astype(hidden.dtype)[..., None]
            token_counts = mask.sum(axis=1)
            if bool(np.any(token_counts <= 0)):
                raise EmbeddingUnavailable("model produced an empty token sequence")
            pooled = (hidden * mask).sum(axis=1) / token_counts
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            if bool(np.any(~np.isfinite(norms))) or bool(np.any(norms <= 0)):
                raise EmbeddingUnavailable("model produced an invalid vector")
            normalized = pooled / norms
            return validate_vectors(normalized.tolist(), expected_count=len(prefixed))

    def preflight(self) -> None:
        """Execute the verified runtime with synthetic, non-private input."""

        self.embed(["health check"], kind="query")

    def _ensure_tokenizer_loaded(self) -> None:
        if self._tokenizer is not None:
            return
        tokenizer = self._load_tokenizer()
        try:
            tokenizer.enable_truncation(max_length=MAX_TOKEN_LENGTH)
            tokenizer.enable_padding()
        except Exception as error:
            raise EmbeddingUnavailable(
                "local embedding tokenizer could not load"
            ) from error
        self._tokenizer = tokenizer

    def _load_tokenizer(self) -> Any:
        try:
            from tokenizers import Tokenizer
        except ImportError as error:
            raise EmbeddingUnavailable(
                "local tokenizer dependency is not installed"
            ) from error
        try:
            tokenizer = Tokenizer.from_file(str(self._files.tokenizer))
            tokenizer.no_truncation()
            tokenizer.no_padding()
            return tokenizer
        except Exception as error:
            raise EmbeddingUnavailable(
                "local embedding tokenizer could not load"
            ) from error

    def _ensure_session_loaded(self) -> None:
        if self._session is not None:
            return
        try:
            import numpy as np
            import onnxruntime as ort
        except ImportError as error:
            raise EmbeddingUnavailable(
                "local inference dependencies are not installed"
            ) from error
        try:
            session = ort.InferenceSession(
                str(self._files.model), providers=["CPUExecutionProvider"]
            )
        except Exception as error:
            raise EmbeddingUnavailable(
                "local embedding model could not load"
            ) from error
        self._numpy = np
        self._session = session


class RemoteEmbeddingProvider:
    """Strict HTTP client for a trusted external embedding service."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        *,
        expected_vector_space_id: str = E5_VECTOR_SPACE_ID,
        timeout: float = 30.0,
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("base_url must be an HTTP(S) origin or path")
        if not isinstance(bearer_token, str) or not bearer_token:
            raise ValueError("bearer_token is required")
        if (
            not isinstance(expected_vector_space_id, str)
            or not expected_vector_space_id
        ):
            raise ValueError("expected_vector_space_id is required")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or timeout <= 0
        ):
            raise ValueError("timeout must be positive")
        self._endpoint = f"{base_url.rstrip('/')}/v1/embeddings"
        self._bearer_token = bearer_token
        self._vector_space_id = expected_vector_space_id
        self._timeout = float(timeout)

    @property
    def vector_space_id(self) -> str:
        return self._vector_space_id

    def embed(self, texts: Sequence[str], *, kind: EmbeddingKind) -> list[list[float]]:
        materialized = _validate_texts(texts)
        if kind not in {"query", "document"}:
            raise InvalidEmbeddingRequest("kind must be query or document")
        body = json.dumps(
            {"kind": kind, "texts": materialized},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        request = Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._bearer_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with _NO_REDIRECT_OPENER.open(request, timeout=self._timeout) as response:
                if response.status != 200:
                    raise EmbeddingUnavailable("embedding service is unavailable")
                raw = response.read(_MAX_REMOTE_RESPONSE_BYTES + 1)
        except (HTTPError, URLError, OSError, TimeoutError) as error:
            raise EmbeddingUnavailable("embedding service is unavailable") from error
        if len(raw) > _MAX_REMOTE_RESPONSE_BYTES:
            raise EmbeddingUnavailable("embedding response is too large")
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise EmbeddingUnavailable("embedding response is invalid") from error
        if not isinstance(payload, dict) or set(payload) != {
            "count",
            "dimension",
            "vector_space_id",
            "vectors",
        }:
            raise EmbeddingUnavailable("embedding response is invalid")
        if (
            payload["count"] != len(materialized)
            or payload["dimension"] != VECTOR_DIMENSION
            or payload["vector_space_id"] != self._vector_space_id
        ):
            raise EmbeddingUnavailable("embedding response does not match the contract")
        return validate_vectors(payload["vectors"], expected_count=len(materialized))

    def preflight(self) -> None:
        """Verify the remote endpoint with synthetic, non-private input."""

        self.embed(["health check"], kind="query")


class _NoRedirectHandler(HTTPRedirectHandler):
    """Reject redirects so bearer credentials never leave the configured endpoint."""

    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        _ = newurl
        raise HTTPError(req.full_url, code, msg, headers, fp)


_NO_REDIRECT_OPENER = build_opener(_NoRedirectHandler())


def _validate_texts(texts: Sequence[str]) -> list[str]:
    if isinstance(texts, (str, bytes)) or not isinstance(texts, Sequence):
        raise InvalidEmbeddingRequest("texts must be a sequence")
    materialized = list(texts)
    if not materialized or any(not isinstance(text, str) for text in materialized):
        raise InvalidEmbeddingRequest("texts must contain strings")
    return materialized


def load_verified_tokenizer(tokenizer_file: str | Path) -> Any:
    """Load only the pinned tokenizer for remote document-indexing clients."""

    path = Path(tokenizer_file)
    try:
        if path.is_symlink() or not path.is_file():
            raise EmbeddingUnavailable("tokenizer file is unavailable")
        if path.stat().st_size != TOKENIZER_FILE_SIZE:
            raise EmbeddingUnavailable("tokenizer file checksum mismatch")
    except EmbeddingUnavailable:
        raise
    except OSError as error:
        raise EmbeddingUnavailable("tokenizer file is unreadable") from error
    if _sha256(path) != TOKENIZER_FILE_SHA256:
        raise EmbeddingUnavailable("tokenizer file checksum mismatch")
    try:
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(path))
        tokenizer.no_truncation()
        tokenizer.no_padding()
        return tokenizer
    except ImportError as error:
        raise EmbeddingUnavailable(
            "local tokenizer dependency is not installed"
        ) from error
    except Exception as error:
        raise EmbeddingUnavailable(
            "local embedding tokenizer could not load"
        ) from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(_HASH_BUFFER_BYTES), b""):
                digest.update(block)
    except OSError as error:
        raise EmbeddingUnavailable("model file is unreadable") from error
    return digest.hexdigest()
