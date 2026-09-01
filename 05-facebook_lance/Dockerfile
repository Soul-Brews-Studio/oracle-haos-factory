ARG BUILD_FROM=python:3.12-slim-bookworm
FROM ${BUILD_FROM}

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"
LABEL org.opencontainers.image.source="https://github.com/Soul-Brews-Studio/oracle-haos-factory" \
      org.opencontainers.image.licenses="MIT" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/data \
    PORT=8104 \
    STUDIO_PORT=8791 \
    LANCE_DB=/share/facebook-lance/facebook.lancedb \
    LANCE_CPU_THREADS=1
WORKDIR /app

# The compat wheel targets the x86-64-v2 baseline used by Ivy Bridge and needs
# glibc plus the standard C++/atomic runtimes. No ONNX runtime or model is added.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --requirement /app/requirements.txt
# lancedb-compat intentionally installs the `lancedb` import namespace while
# some dependencies inspect the ordinary distribution metadata by that name.
RUN python - <<'PY'
from pathlib import Path
from site import getsitepackages

metadata = Path(getsitepackages()[0]) / "lancedb-0.38.0.dist-info" / "METADATA"
metadata.parent.mkdir(parents=True, exist_ok=True)
metadata.write_text(
    "Metadata-Version: 2.1\nName: lancedb\nVersion: 0.38.0\n",
    encoding="utf-8",
)
PY
RUN python - <<'PY'
import lancedb
from lancedb.pydantic import LanceModel, Vector

assert lancedb.__version__ == "0.38.0"

class _VectorProbe(LanceModel):
    vector: Vector(3)

assert _VectorProbe.to_arrow_schema().field("vector").type.list_size == 3
PY

COPY app /app
COPY service.py /app/service.py
COPY run.sh /run.sh
RUN chmod 0755 /run.sh \
    && python -m compileall -q /app

EXPOSE 8104
CMD ["/run.sh"]
