#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

export PORT=8101

bashio::log.info "Echo starting on port 8101"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
