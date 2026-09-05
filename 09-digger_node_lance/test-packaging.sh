#!/bin/bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE

bash -n "${HERE}/run.sh" "${HERE}/build-local.sh" "${HERE}/test-packaging.sh"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${HERE}/run.sh" "${HERE}/build-local.sh" "${HERE}/test-packaging.sh"
fi

PYCACHE="$(mktemp -d /tmp/digger-lance-pycache.XXXXXX)"
PYTHONPYCACHEPREFIX="${PYCACHE}" python3 -m py_compile \
  "${HERE}/prepare-pocketbase.py" \
  "${HERE}/verify-pocketbase-assets.py" \
  "${HERE}/read-option.py" \
  "${HERE}/bootstrap-pocketbase.py"

ruby -e '
  require "yaml"
  c = YAML.safe_load(File.read(ARGV.fetch(0)))
  abort "wrong slug" unless c["slug"] == "digger_node_lance"
  abort "wrong version" unless c["version"] == "0.1.0"
  abort "wrong ingress" unless c["ingress_port"] == 8111
  abort "panel must be admin-only" unless c["panel_admin"] == true
  abort "wrong mapped port" unless c.dig("ports", "8111/tcp") == 8111
  abort "wrong architecture set" unless c["arch"].sort == %w[aarch64 amd64]
  abort "PocketBase must not be exposed" if c.fetch("ports").keys.any? { |p| p.start_with?("8090/") }
' "${HERE}/config.yaml"

grep -Fq 'ARG PB_VERSION=0.29.3' "${HERE}/Dockerfile"
grep -Fq 'ARG BUN_IMAGE=oven/bun:1.3.14-debian' "${HERE}/Dockerfile"
grep -Fq 'python:3.12-slim-bookworm' "${HERE}/Dockerfile"
grep -Fq 'MODEL_CACHE=/opt/models' "${HERE}/Dockerfile"
grep -Fq -- '--build-context' "${HERE}/build-local.sh"

if grep -n -F '/data/digger.db' \
  "${HERE}/Dockerfile" "${HERE}/run.sh" "${HERE}/config.yaml" \
  "${HERE}/bootstrap-pocketbase.py" "${HERE}/read-option.py"; then
  echo "new add-on must never reference the legacy live database" >&2
  exit 1
fi

PATCH_FIXTURE="$(mktemp /tmp/digger-pb-patch.XXXXXX)"
printf 'before:%s:after' '__pb_superuser_auth__' >"${PATCH_FIXTURE}"
python3 "${HERE}/prepare-pocketbase.py" "${PATCH_FIXTURE}" >/dev/null
grep -Fq '__dn_superuser_auth__' "${PATCH_FIXTURE}"
if grep -Fq '__pb_superuser_auth__' "${PATCH_FIXTURE}"; then
  echo "PocketBase patch fixture retained the shared key" >&2
  exit 1
fi

OPTIONS_FIXTURE="$(mktemp /tmp/digger-options.XXXXXX)"
printf '%s\n' '{"instance_name":"fixture","pb_auto_login":true}' >"${OPTIONS_FIXTURE}"
test "$(python3 "${HERE}/read-option.py" "${OPTIONS_FIXTURE}" instance_name fallback)" = fixture
test "$(python3 "${HERE}/read-option.py" "${OPTIONS_FIXTURE}" pb_auto_login false)" = true
test "$(python3 "${HERE}/read-option.py" "${OPTIONS_FIXTURE}" missing fallback)" = fallback

echo "09-digger_node_lance packaging checks passed"
