ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22
FROM ${BUILD_FROM}

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64
ARG PB_VERSION=0.29.3
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache ca-certificates curl python3 unzip \
 && case "${BUILD_ARCH}" in amd64) PB_ARCH=amd64 ;; aarch64) PB_ARCH=arm64 ;; *) exit 1 ;; esac \
 && curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" -o /tmp/pb.zip \
 && unzip -q /tmp/pb.zip -d /pb \
 && chmod 0755 /pb/pocketbase \
 && /pb/pocketbase --version | grep -F "${PB_VERSION}" \
 && rm /tmp/pb.zip

COPY pb_hooks/ /pb/pb_hooks/
COPY pb_migrations/ /pb/pb_migrations/
COPY pb_public/ /pb/pb_public/
COPY backfill.py /app/backfill.py
COPY run.sh /run.sh
RUN chmod 0755 /run.sh /app/backfill.py
EXPOSE 8110
CMD ["/run.sh"]
