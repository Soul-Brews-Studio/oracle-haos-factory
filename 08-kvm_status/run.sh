#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

REFRESH_SECONDS="$(bashio::config 'refresh_seconds')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${REFRESH_SECONDS}" = "null" ] && REFRESH_SECONDS='5'
export REFRESH_SECONDS

DISK_WARN_PERCENT="$(bashio::config 'disk_warn_percent')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${DISK_WARN_PERCENT}" = "null" ] && DISK_WARN_PERCENT='80'
export DISK_WARN_PERCENT

DISK_CRITICAL_PERCENT="$(bashio::config 'disk_critical_percent')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${DISK_CRITICAL_PERCENT}" = "null" ] && DISK_CRITICAL_PERCENT='90'
export DISK_CRITICAL_PERCENT

export PORT=8109

bashio::log.info "Kvm Status starting on port 8109"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
