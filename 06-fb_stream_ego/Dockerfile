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
    PORT=8105
WORKDIR /app

COPY server.ts /app/server.ts
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
