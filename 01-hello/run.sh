#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Supervisor stores options outside the process. This bridge is deliberately the
# second of three matching edits: config.yaml declares the value, this file
# exports it, and server.ts reads it. Omitting this middle step makes the UI show
# a saved greeting while the running server silently keeps its default.

set -eu

GREETING="$(bashio::config 'greeting')"
# bashio renders an unset optional string as the literal "null"; accepting that
# would turn an absent value into visible user content instead of the default.
[ "${GREETING}" = "null" ] && GREETING="hello"
export GREETING
export PORT=8099

bashio::log.info "Hello starting on port ${PORT}"
# exec lets Bun receive Supervisor/s6 stop signals directly instead of leaving a
# shell parent that delays restart until the kill timeout.
exec bun /app/server.ts
