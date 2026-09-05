#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

EXPORTER_URL="$(bashio::config 'exporter_url')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${EXPORTER_URL}" = "null" ] && EXPORTER_URL='http://a0d7b954-ssh:18795'
export EXPORTER_URL

REFRESH_SECONDS="$(bashio::config 'refresh_seconds')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${REFRESH_SECONDS}" = "null" ] && REFRESH_SECONDS='10'
export REFRESH_SECONDS

# Optional secret: exported only when set. It never appears in argv or in this log line.
if bashio::config.has_value 'exporter_token'; then
  EXPORTER_TOKEN="$(bashio::config 'exporter_token')"
  export EXPORTER_TOKEN
fi

export PORT=8105

bashio::log.info "FB Stream Ego starting on port 8105; exporter ${EXPORTER_URL}; refresh ${REFRESH_SECONDS}s"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
