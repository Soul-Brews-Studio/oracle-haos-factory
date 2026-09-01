#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

EXPORTER_URL="$(bashio::config 'exporter_url')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${EXPORTER_URL}" = "null" ] && EXPORTER_URL='http://192.168.122.1:9108'
export EXPORTER_URL

REFRESH_SECONDS="$(bashio::config 'refresh_seconds')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${REFRESH_SECONDS}" = "null" ] && REFRESH_SECONDS='10'
export REFRESH_SECONDS

export PORT=8102

bashio::log.info "KVM Monitor starting on port 8102; exporter ${EXPORTER_URL}"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
