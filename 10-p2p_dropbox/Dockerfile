ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22@sha256:536c6164d3ef70a275573334e3c52b77e4cb90a90776e0ca609089deb5357b25
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS bun
FROM ${BUILD_FROM}
ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=0.1.0
LABEL io.hass.type="addon" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}"
RUN apk add --no-cache libstdc++ libgcc ca-certificates
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = "1.3.14"
WORKDIR /app/dropbox
COPY dropbox/package.json dropbox/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY dropbox/*.ts ./
COPY dropbox/web-dist/ ./web-dist/
COPY options.ts health.ts /app/
COPY run.sh /run.sh
COPY rootfs/ /
RUN mkdir -p /data /share \
 && chmod 0755 /run.sh /etc/cont-init.d/10-p2p-options /etc/services.d/*/run
EXPOSE 3847/tcp
# /init from the HA base supervises both services and reaps their children.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD s6-envdir /run/p2p/env bun /app/health.ts
