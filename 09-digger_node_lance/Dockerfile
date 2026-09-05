# syntax=docker/dockerfile:1.7

ARG BUILD_FROM=python:3.12-slim-bookworm
ARG BUN_IMAGE=oven/bun:1.3.14-debian
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.8

FROM ${BUN_IMAGE} AS app-build
ARG APP_SOURCE_SHA
WORKDIR /app
RUN test -n "${APP_SOURCE_SHA}" \
 && printf '%s\n' "${APP_SOURCE_SHA}" | grep -Eq '^[0-9a-f]{40}$' \
 && echo "building digger-node source ${APP_SOURCE_SHA}"
COPY --from=app package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY --from=app src/ ./src/
COPY --from=app test/ ./test/
RUN bun test ./test \
 && bun run typecheck \
 && bun install --production --frozen-lockfile

FROM ${UV_IMAGE} AS uv-bin

FROM ${BUILD_FROM} AS python-build
ENV UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/python \
    MODEL_CACHE=/opt/models \
    FASTEMBED_CACHE_PATH=/opt/models
WORKDIR /app
COPY --from=uv-bin /uv /usr/local/bin/uv
COPY --from=app pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --from=app python/ ./python/
RUN .venv/bin/python -m unittest discover -s python/tests -v \
 && .venv/bin/python -m digger_lance.download_model \
 && test -n "$(find /opt/models -mindepth 1 -print -quit)"

FROM ${BUILD_FROM} AS pocketbase-build
ARG PB_VERSION=0.29.3
ARG BUILD_ARCH=amd64
ARG TARGETARCH
ARG PB_SHA256_AMD64=c0c4ef56b74a17c469b74c00c40d90ec20b6fd33cd45bf1f9993fbf86f03c695
ARG PB_SHA256_ARM64=2caee88941e2d571acc2c51e0f0a6c247f07de16a7524019e4808be56cadb9bd
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
COPY prepare-pocketbase.py verify-pocketbase-assets.py /tools/
RUN set -eu; \
    requested_arch="${TARGETARCH:-${BUILD_ARCH}}"; \
    case "${requested_arch}" in \
      amd64) pb_arch=amd64; pb_sha="${PB_SHA256_AMD64}" ;; \
      arm64|aarch64) pb_arch=arm64; pb_sha="${PB_SHA256_ARM64}" ;; \
      *) echo "unsupported PocketBase architecture: ${requested_arch}" >&2; exit 1 ;; \
    esac; \
    archive="pocketbase_${PB_VERSION}_linux_${pb_arch}.zip"; \
    curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${archive}" -o /tmp/pocketbase.zip; \
    echo "${pb_sha}  /tmp/pocketbase.zip" | sha256sum -c -; \
    mkdir -p /opt/pocketbase; \
    unzip -q /tmp/pocketbase.zip pocketbase -d /opt/pocketbase; \
    python3 /tools/prepare-pocketbase.py /opt/pocketbase/pocketbase; \
    /opt/pocketbase/pocketbase --version

# Checking strings in the executable is not enough: prove the patched key is
# what a real PocketBase process serves from its embedded admin assets.
RUN set -eu; \
    /opt/pocketbase/pocketbase serve --http=127.0.0.1:18090 --dir=/tmp/pb-proof >/tmp/pb-proof.log 2>&1 & \
    pid=$!; \
    trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT; \
    ready=0; \
    for _ in $(seq 1 30); do \
      if curl -fsS http://127.0.0.1:18090/api/health >/dev/null 2>&1; then ready=1; break; fi; \
      kill -0 "$pid" 2>/dev/null || { cat /tmp/pb-proof.log >&2; exit 1; }; \
      sleep 1; \
    done; \
    test "$ready" = 1; \
    python3 /tools/verify-pocketbase-assets.py http://127.0.0.1:18090/; \
    kill "$pid"; \
    wait "$pid" || true; \
    trap - EXIT

FROM ${BUILD_FROM}
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH=amd64
ARG APP_SOURCE_SHA
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.source="https://github.com/Soul-Brews-Studio/oracle-haos-factory" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${APP_SOURCE_SHA}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/python \
    PATH=/app/.venv/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/data \
    PORT=8111 \
    POCKETBASE_URL=http://127.0.0.1:8090 \
    LANCE_URL=http://127.0.0.1:8110 \
    LANCE_PATH=/data/lancedb \
    MODEL_CACHE=/opt/models \
    FASTEMBED_CACHE_PATH=/opt/models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl libatomic1 libgomp1 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=app-build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=app-build /app/node_modules/ ./node_modules/
COPY --from=app package.json bun.lock ./
COPY --from=app src/ ./src/
COPY --from=app python/ ./python/
COPY --from=app pocketbase/pb_hooks/ ./pocketbase/pb_hooks/
COPY --from=app pocketbase/pb_migrations/ ./pocketbase/pb_migrations/
COPY --from=python-build /app/.venv/ ./.venv/
COPY --from=python-build /opt/models/ /opt/models/
COPY --from=pocketbase-build /opt/pocketbase/pocketbase ./pocketbase/pocketbase
COPY read-option.py bootstrap-pocketbase.py ./addon/
COPY run.sh /run.sh
RUN chmod 0755 /run.sh ./addon/*.py ./pocketbase/pocketbase \
 && test -x /usr/local/bin/bun \
 && test -x ./.venv/bin/python \
 && test -x ./pocketbase/pocketbase \
 && test -f ./src/lance-server.ts

EXPOSE 8111
CMD ["/run.sh"]
