# A digest-pinned default keeps plain local builds reproducible; the HA
# builder overrides BUILD_FROM with the matching per-arch base in build.yaml.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
FROM ${BUILD_FROM}

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

# HA's Alpine base requires Bun's musl build; the glibc binary fails with a
# misleading "not found" even when the executable is present.
RUN apk add --no-cache libstdc++ unzip curl \
 && case "${BUILD_ARCH}" in \
      amd64)   BUN_TARGET="bun-linux-x64-musl" ;; \
      aarch64) BUN_TARGET="bun-linux-aarch64-musl" ;; \
      *)       echo "unsupported arch: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/${BUN_TARGET}.zip" -o /tmp/bun.zip \
 && unzip -q /tmp/bun.zip -d /tmp \
 && mv "/tmp/${BUN_TARGET}/bun" /usr/local/bin/bun \
 && chmod 0755 /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip "/tmp/${BUN_TARGET}" \
 && bun --version

# Future home-derived state belongs below the only persisted and backed-up path.
ENV HOME=/data \
    PORT=8109
WORKDIR /app

# Vendored, never a CDN: a Home Assistant box on a LAN without internet is a
# normal deployment, and a CDN-loaded UI renders a blank panel there with no
# error anyone can see. Pinned to React 18 because 19 dropped the UMD builds a
# no-build page depends on.
RUN mkdir -p /app/vendor \
 && curl -fsSL https://unpkg.com/react@18.3.1/umd/react.production.min.js      -o /app/vendor/react.js \
 && curl -fsSL https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js -o /app/vendor/react-dom.js \
 && curl -fsSL https://unpkg.com/htm@3.1.1/dist/htm.umd.js                     -o /app/vendor/htm.js \
 && for f in react react-dom htm; do test -s "/app/vendor/$f.js" || { echo "vendor fetch failed: $f" >&2; exit 1; }; done \
 && wc -c /app/vendor/*.js

COPY server.ts /app/server.ts
# The page is a real .html file — see the note in server.ts on why it is not
# a template literal in the source.
COPY web/ /app/web/
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
