#!/bin/sh
set -eu
umask 077

APP_DIR="${APP_DIR:-/app}"
GATEWAY_DIR="${GATEWAY_DIR:-${APP_DIR}/gateway}"
DB_PATH="${LANCE_DB:-/share/line-lance/line.lance}"
PYTHON_BIN="${PYTHON_BIN:-python}"
NODE_BIN="${NODE_BIN:-node}"
ARCHIVE_HOST="127.0.0.1"
ARCHIVE_PORT="${ARCHIVE_PORT:-4133}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8103}"
READY_TIMEOUT="${ARCHIVE_READY_TIMEOUT:-30}"
DATA_DIR="${DATA_DIR:-/data}"

archive_command="${PYTHON_BIN} ${APP_DIR}/app.py --db ${DB_PATH} serve --host ${ARCHIVE_HOST} --port ${ARCHIVE_PORT}"
gateway_command="${NODE_BIN} ${GATEWAY_DIR}/dist/src/index.js"
if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '%s\n' "umask=077"
    printf '%s\n' "archive: ${archive_command}"
    printf '%s\n' "gateway: HOST=${HOST} PORT=${PORT} ARCHIVE_ORIGIN=http://${ARCHIVE_HOST}:${ARCHIVE_PORT} STATIC_DIR=${STATIC_DIR:-${APP_DIR}/frontend/dist} CONTROL_DB=${CONTROL_DB:-${DATA_DIR}/line-lance-control.sqlite} CONTROL_KEY=${CONTROL_KEY:-${DATA_DIR}/line-lance-control.key} ${gateway_command}"
    exit 0
fi

mkdir -p "$(dirname "${DB_PATH}")" "${DATA_DIR}"

cleanup() {
    trap - INT TERM EXIT
    [ -z "${gateway_pid:-}" ] || kill "${gateway_pid}" 2>/dev/null || true
    [ -z "${archive_pid:-}" ] || kill "${archive_pid}" 2>/dev/null || true
    [ -z "${gateway_pid:-}" ] || wait "${gateway_pid}" 2>/dev/null || true
    [ -z "${archive_pid:-}" ] || wait "${archive_pid}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "LINE Lance archive: http://${ARCHIVE_HOST}:${ARCHIVE_PORT}; db=${DB_PATH}"
"${PYTHON_BIN}" "${APP_DIR}/app.py" --db "${DB_PATH}" serve --host "${ARCHIVE_HOST}" --port "${ARCHIVE_PORT}" &
archive_pid=$!
ready=0
attempt=0
while [ "${attempt}" -lt "${READY_TIMEOUT}" ]; do
    if ! kill -0 "${archive_pid}" 2>/dev/null; then
        wait "${archive_pid}" || status=$?
        echo "LINE Lance archive exited before readiness" >&2
        exit "${status:-1}"
    fi
    if "${PYTHON_BIN}" -c "import urllib.request; urllib.request.urlopen('http://${ARCHIVE_HOST}:${ARCHIVE_PORT}/api/health', timeout=1).read()" >/dev/null 2>&1; then
        ready=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
if [ "${ready}" -ne 1 ]; then
    echo "LINE Lance archive readiness timed out after ${READY_TIMEOUT}s" >&2
    exit 1
fi

export HOST PORT
export ARCHIVE_ORIGIN="http://${ARCHIVE_HOST}:${ARCHIVE_PORT}"
export STATIC_DIR="${STATIC_DIR:-${APP_DIR}/frontend/dist}"
export CONTROL_DB="${CONTROL_DB:-${DATA_DIR}/line-lance-control.sqlite}"
export CONTROL_KEY="${CONTROL_KEY:-${DATA_DIR}/line-lance-control.key}"
echo "LINE Lance gateway: http://${HOST}:${PORT}; archive=${ARCHIVE_ORIGIN}"
"${NODE_BIN}" "${GATEWAY_DIR}/dist/src/index.js" &
gateway_pid=$!

status=0
while kill -0 "${archive_pid}" 2>/dev/null && kill -0 "${gateway_pid}" 2>/dev/null; do sleep 1; done
if ! kill -0 "${archive_pid}" 2>/dev/null; then
    wait "${archive_pid}" || status=$?
    echo "LINE Lance archive stopped; terminating gateway" >&2
else
    wait "${gateway_pid}" || status=$?
    echo "LINE Lance gateway stopped; terminating archive" >&2
fi
exit "${status}"
