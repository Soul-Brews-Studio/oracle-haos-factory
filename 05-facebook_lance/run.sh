#!/bin/sh
set -eu
umask 077

export PORT="${PORT:-8104}"
export STUDIO_PORT="${STUDIO_PORT:-8791}"
export LANCE_DB="${LANCE_DB:-/share/facebook-lance/facebook.lancedb}"
export OPTIONS_PATH="${OPTIONS_PATH:-/data/options.json}"
export APP_DIR="${APP_DIR:-/app}"

exec python "${APP_DIR}/service.py"
