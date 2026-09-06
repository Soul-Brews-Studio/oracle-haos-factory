ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22
FROM ${BUILD_FROM}

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64
ENV PB_VERSION=0.29.3
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="addon" io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache ca-certificates curl python3 unzip \
 && case "${BUILD_ARCH}" in \
      amd64) PB_ARCH=amd64; PB_SHA=c0c4ef56b74a17c469b74c00c40d90ec20b6fd33cd45bf1f9993fbf86f03c695 ;; \
      aarch64) PB_ARCH=arm64; PB_SHA=2caee88941e2d571acc2c51e0f0a6c247f07de16a7524019e4808be56cadb9bd ;; \
      *) exit 1 ;; esac \
 && curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" -o /tmp/pb.zip \
 && echo "${PB_SHA}  /tmp/pb.zip" | sha256sum -c - \
 && unzip -q /tmp/pb.zip -d /pb \
 && chmod 0755 /pb/pocketbase \
 && /pb/pocketbase --version | grep -Fx "pocketbase version ${PB_VERSION}" \
 && rm /tmp/pb.zip

COPY namespace_admin.py /app/namespace_admin.py
RUN python3 /app/namespace_admin.py /pb/pocketbase
COPY pb_hooks/ /pb/pb_hooks/
COPY pb_migrations/ /pb/pb_migrations/
COPY pb_public/ /pb/pb_public/
COPY backfill.py service.py /app/
COPY run.sh /run.sh
RUN chmod 0755 /run.sh /app/backfill.py
EXPOSE 8110
CMD ["/run.sh"]
