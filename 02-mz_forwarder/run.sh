#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

MQTT_HOST="$(bashio::config 'mqtt_host')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${MQTT_HOST}" = "null" ] && MQTT_HOST='mqtt.laris.co'
export MQTT_HOST

MQTT_USER="$(bashio::config 'mqtt_user')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${MQTT_USER}" = "null" ] && MQTT_USER='nat'
export MQTT_USER

MQTT_PASS="$(bashio::config 'mqtt_pass')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${MQTT_PASS}" = "null" ] && MQTT_PASS='changeme'
export MQTT_PASS

TOPIC="$(bashio::config 'topic')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${TOPIC}" = "null" ] && TOPIC='FloodBoy/#'
export TOPIC

API_ENDPOINT="$(bashio::config 'api_endpoint')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${API_ENDPOINT}" = "null" ] && API_ENDPOINT=''
export API_ENDPOINT

DRY_RUN="$(bashio::config 'dry_run')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${DRY_RUN}" = "null" ] && DRY_RUN='true'
export DRY_RUN

export PORT=8100

bashio::log.info "Mz Forwarder starting on port 8100"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
