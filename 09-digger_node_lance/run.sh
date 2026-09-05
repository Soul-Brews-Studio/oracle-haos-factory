#!/bin/bash
# shellcheck shell=bash
set -Eeuo pipefail
umask 077

readonly APP_DIR="${APP_DIR:-/app}"
readonly ADDON_SUPPORT_DIR="${ADDON_SUPPORT_DIR:-${APP_DIR}/addon}"
readonly OPTIONS_FILE="${OPTIONS_FILE:-/data/options.json}"
readonly DATA_DIR="${DATA_DIR:-/data}"
readonly PB_DATA_DIR="${PB_DATA_DIR:-${DATA_DIR}/pb_data}"
readonly LANCE_PATH="${LANCE_PATH:-${DATA_DIR}/lancedb}"
readonly PB_URL="http://127.0.0.1:8090"
readonly LANCE_URL="http://127.0.0.1:8110"
readonly PUBLIC_URL_INTERNAL="http://127.0.0.1:8111"
readonly SECRET_FILE="${DATA_DIR}/digger_internal_token"
readonly PB_PASSWORD_FILE="${DATA_DIR}/pb_superuser_password"

read_option() {
  python3 "${ADDON_SUPPORT_DIR}/read-option.py" "${OPTIONS_FILE}" "$1" "$2"
}

INSTANCE_NAME="$(read_option instance_name digger-node-lance)"
OWNER_PASSPHRASE="$(read_option owner_passphrase '')"
API_TOKEN="$(read_option api_token '')"
RATE_LIMIT="$(read_option rate_limit on)"
INGRESS_AUTO_LOGIN="$(read_option auto_login true)"
PUBLIC_URL="$(read_option public_url '')"
PB_AUTO_LOGIN="$(read_option pb_auto_login false)"
PB_ADMIN_HA_USER_IDS="$(read_option pb_admin_ha_user_ids '')"
PB_OWNER_EMAIL="$(read_option pb_owner_email owner@digger.invalid)"
PB_SUPERUSER_EMAIL="$(read_option pb_superuser_email admin@digger.invalid)"
CONFIGURED_PB_PASSWORD="$(read_option pb_superuser_password '')"

export INSTANCE_NAME OWNER_PASSPHRASE API_TOKEN RATE_LIMIT INGRESS_AUTO_LOGIN
export PUBLIC_URL PB_AUTO_LOGIN PB_ADMIN_HA_USER_IDS PB_OWNER_EMAIL PB_SUPERUSER_EMAIL
export PORT=8111
export LANCE_URL POCKETBASE_URL="${PB_URL}"
export LANCE_HOST=127.0.0.1 LANCE_PORT=8110
export LANCE_PATH PYTHONPATH="${APP_DIR}/python"
export MODEL_CACHE=/opt/models FASTEMBED_CACHE_PATH=/opt/models
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export HOME="${DATA_DIR}"
export PB_ADMIN_STORAGE_KEY="__dn_superuser_auth__"

mkdir -p "${DATA_DIR}" "${PB_DATA_DIR}" "${LANCE_PATH}"

persist_secret() {
  local destination="$1"
  local configured="$2"
  local temporary
  if [[ ! -s "${destination}" ]]; then
    temporary="$(mktemp "${destination}.tmp.XXXXXX")"
    if [[ -n "${configured}" ]]; then
      printf '%s\n' "${configured}" >"${temporary}"
    else
      python3 -c 'import secrets; print(secrets.token_urlsafe(48))' >"${temporary}"
    fi
    chmod 0600 "${temporary}"
    mv "${temporary}" "${destination}"
  fi
  chmod 0600 "${destination}"
}

persist_secret "${SECRET_FILE}" ""
persist_secret "${PB_PASSWORD_FILE}" "${CONFIGURED_PB_PASSWORD}"
IFS= read -r DIGGER_INTERNAL_TOKEN <"${SECRET_FILE}"
IFS= read -r PB_SUPERUSER_PASSWORD <"${PB_PASSWORD_FILE}"
if [[ -z "${DIGGER_INTERNAL_TOKEN}" || -z "${PB_SUPERUSER_PASSWORD}" ]]; then
  echo "persisted runtime secret is empty" >&2
  exit 1
fi
export DIGGER_INTERNAL_TOKEN
unset CONFIGURED_PB_PASSWORD

if [[ -z "${OWNER_PASSPHRASE}" && -z "${API_TOKEN}" ]]; then
  echo "WARNING: no owner_passphrase and no api_token; mapped port 8111 is open" >&2
fi
if [[ "${PB_AUTO_LOGIN}" == "true" && -z "${PB_ADMIN_HA_USER_IDS}" ]]; then
  echo "WARNING: pb_auto_login is enabled but the HA user-ID allowlist is empty; admin bootstrap denies everyone" >&2
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' \
    "PocketBase: 127.0.0.1:8090 data=${PB_DATA_DIR}" \
    "Lance service: 127.0.0.1:8110 data=${LANCE_PATH} model=${MODEL_CACHE}" \
    "Digger Node Lance: 0.0.0.0:8111"
  exit 0
fi

declare -a child_pids=()
declare -a child_names=()

stop_children() {
  trap - INT TERM HUP EXIT
  local pid alive
  for pid in "${child_pids[@]}"; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
  local deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    alive=0
    for pid in "${child_pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && break
    sleep 0.2
  done
  for pid in "${child_pids[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      echo "child ${pid} did not stop within 10s; sending KILL" >&2
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
  for pid in "${child_pids[@]}"; do
    wait "${pid}" 2>/dev/null || true
  done
}

on_signal() {
  echo "shutdown requested; stopping Digger Node Lance services"
  stop_children
  exit 0
}
trap on_signal INT TERM HUP
trap stop_children EXIT

start_child() {
  local name="$1"
  shift
  "$@" &
  child_names+=("${name}")
  child_pids+=("$!")
}

wait_for_url() {
  local name="$1"
  local pid="$2"
  local url="$3"
  local timeout="$4"
  local started="${SECONDS}"
  while (( SECONDS - started < timeout )); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      local status=0
      wait "${pid}" || status=$?
      echo "${name} exited before readiness (status=${status})" >&2
      (( status == 0 )) && status=1
      return "${status}"
    fi
    if curl --fail --silent --show-error --max-time 2 "${url}" >/dev/null 2>&1; then
      echo "${name} ready"
      return 0
    fi
    sleep 1
  done
  echo "${name} readiness timed out after ${timeout}s" >&2
  return 1
}

echo "starting PocketBase privately on 127.0.0.1:8090"
start_child PocketBase \
  "${APP_DIR}/pocketbase/pocketbase" serve \
  --http=127.0.0.1:8090 \
  --dir="${PB_DATA_DIR}" \
  --hooksDir="${APP_DIR}/pocketbase/pb_hooks" \
  --migrationsDir="${APP_DIR}/pocketbase/pb_migrations"
pb_pid="${child_pids[-1]}"
wait_for_url PocketBase "${pb_pid}" "${PB_URL}/api/health" 60

# The private bootstrap hook creates only missing records. Secrets travel in a
# loopback JSON body and process environment, never argv or logs.
PB_SUPERUSER_PASSWORD="${PB_SUPERUSER_PASSWORD}" \
  python3 "${ADDON_SUPPORT_DIR}/bootstrap-pocketbase.py"

echo "starting Python Lance service privately on 127.0.0.1:8110"
start_child LanceDB python3 -m digger_lance.server
lance_pid="${child_pids[-1]}"
wait_for_url LanceDB "${lance_pid}" "${LANCE_URL}/health" 180

echo "starting Digger Node Lance on 0.0.0.0:8111"
start_bun() {
  # The Bun bootstrap independently confirms the record exists. Give only Bun
  # this initial credential; PB and Python never inherit it and it is not argv.
  export PB_SUPERUSER_PASSWORD
  exec bun "${APP_DIR}/src/lance-server.ts"
}
start_child Bun start_bun
bun_pid="${child_pids[-1]}"
unset PB_SUPERUSER_PASSWORD
wait_for_url Bun "${bun_pid}" "${PUBLIC_URL_INTERNAL}/health" 60

python3 - <<'PY'
import json
from urllib.request import urlopen

with urlopen("http://127.0.0.1:8111/health", timeout=5) as response:
    health = json.load(response)
assert health.get("ok") is True, health
assert health.get("driver") == "lancedb", health
assert health.get("tools") == 19, health
assert health.get("embedder") is not None, health
print("public health verified: driver=lancedb tools=19 embedder=non-null")
PY

while true; do
  for index in "${!child_pids[@]}"; do
    pid="${child_pids[$index]}"
    if ! kill -0 "${pid}" 2>/dev/null; then
      status=0
      wait "${pid}" || status=$?
      echo "${child_names[$index]} stopped (status=${status}); terminating sibling services" >&2
      stop_children
      (( status == 0 )) && status=1
      exit "${status}"
    fi
  done
  sleep 1
done
