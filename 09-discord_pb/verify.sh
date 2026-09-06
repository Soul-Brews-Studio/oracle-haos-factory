#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
export PB_URL="${PB_URL:-http://127.0.0.1:8110}"
export SQLITE_DB="${SQLITE_DB:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite}"
: "${CHANNELS:?set CHANNELS to comma-separated channel IDs or all}"
export CHANNELS

exec python3 "$script_dir/verify.py"
