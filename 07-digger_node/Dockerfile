# A digest-pinned default keeps plain local builds reproducible; the HA
# builder overrides BUILD_FROM with the matching per-arch base in build.yaml.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
FROM ${BUILD_FROM}

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"

# The application is NOT vendored into this repository. digger-node is its own
# public repo with its own test suite and CalVer tags, and copying its source
# here would create the stale-duplicate failure this factory already documents:
# a committed copy that drifts from its source without ever saying so.
#
# Pinned to a commit rather than a branch, deliberately. `main` would make two
# builds of the same add-on version contain different application code, which is
# the "update succeeded but nothing changed" trap wearing a different hat. Bump
# this and the add-on version together, never one alone.
ARG DIGGER_NODE_REPO="https://github.com/Soul-Brews-Studio/digger-node.git"
# The FULL 40-character SHA, and that is not cosmetic: GitHub refuses
# `git fetch origin <abbreviated-sha>` with a bare exit 128 and no explanation.
# Measured here — the first build of this add-on died exactly that way.
ARG DIGGER_NODE_REF="a29df72d638cefe73ba3d2f7cf2044310ced9950"

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

# HA's Alpine base requires Bun's musl build; the glibc binary fails with a
# misleading "not found" even when the executable is present.
RUN apk add --no-cache libstdc++ unzip curl git \
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

WORKDIR /app

# Fetch exactly one commit rather than cloning history — the image needs the
# tree, not the log. `git -c advice...` keeps the detached-HEAD notice out of
# build output where it reads as a warning about something being wrong.
RUN git init -q . \
 && git remote add origin "${DIGGER_NODE_REPO}" \
 && git fetch --depth 1 origin "${DIGGER_NODE_REF}" \
 && git -c advice.detachedHead=false checkout -q FETCH_HEAD \
 && rm -rf .git \
 && test -f src/server.ts \
 && test -d migrations \
 && echo "digger-node ${DIGGER_NODE_REF}: $(ls migrations/*.sql | wc -l) migrations"

# --production drops the test-only tree. bun:sqlite is part of the runtime, so
# there is no native module to compile per-arch and the aarch64 build stays as
# honest as the amd64 one.
RUN bun install --production --frozen-lockfile \
 && bun --eval 'import("./src/app.ts").then(() => console.log("app module loads"))'

# /data is the only path Supervisor persists across updates and includes in
# backups, so the corpus and HOME-derived state both belong under it.
ENV HOME=/data \
    PORT=8108 \
    DB_PATH=/data/digger.db \
    MIGRATIONS_DIR=/app/migrations

COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
