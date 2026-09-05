FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim AS gateway-build
WORKDIR /build/gateway
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci
COPY gateway/ ./
RUN npm run typecheck && npm test && npm prune --omit=dev

# LanceDB's compatibility wheel needs glibc Python. Node comes from the pinned
# official image so the final runtime does not need another package repository.
FROM python:3.12-slim-bookworm
ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"
LABEL org.opencontainers.image.source="https://github.com/Soul-Brews-Studio/oracle-haos-factory" \
      org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production HOME=/data \
    PORT=8103 ARCHIVE_PORT=4133 ARCHIVE_ORIGIN=http://127.0.0.1:4133 \
    STATIC_DIR=/app/frontend/dist CONTROL_DB=/data/line-lance-control.sqlite \
    CONTROL_KEY=/data/line-lance-control.key \
    LANCE_DB=/share/line-lance/line.lance
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --requirement /app/requirements.txt
# lancedb-compat uses another distribution name although the shared package
# requests `lancedb` metadata. Supply that alias and verify the import.
RUN python - <<'PY'
from pathlib import Path
from site import getsitepackages
metadata = Path(getsitepackages()[0]) / "lancedb-0.37.1.dist-info" / "METADATA"
metadata.parent.mkdir(parents=True, exist_ok=True)
metadata.write_text("Metadata-Version: 2.1\nName: lancedb\nVersion: 0.37.1\n", encoding="utf-8")
PY
RUN python -c 'import lancedb; assert lancedb.__version__ == "0.37.1"'
COPY --from=gateway-build /usr/local/bin/node /usr/local/bin/node
RUN node --version && test "$(node -p 'process.versions.node.split(`.`)[0]')" = "24"
COPY --from=gateway-build /build/gateway/dist /app/gateway/dist
COPY --from=gateway-build /build/gateway/node_modules /app/gateway/node_modules
COPY --from=gateway-build /build/gateway/package.json /app/gateway/package.json
COPY --from=frontend-build /build/frontend/dist /app/frontend/dist
ENV APP_SLUG=line_lance APP_VERSION=0.3.0 \
    LANCE_DATABASE_LABEL="HAOS private shared archive" \
    LINE_SOURCE_LABEL="Webhook-relay D1 export pages"
COPY app.py store.py models.py /app/
COPY run.sh /run.sh
RUN chmod 0755 /run.sh
EXPOSE 8103
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.arch="${BUILD_ARCH}"
CMD ["/run.sh"]
