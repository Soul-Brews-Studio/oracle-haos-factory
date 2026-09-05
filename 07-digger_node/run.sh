#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

INSTANCE_NAME="$(bashio::config 'instance_name')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${INSTANCE_NAME}" = "null" ] && INSTANCE_NAME='kvmlab1'
export INSTANCE_NAME

OWNER_PASSPHRASE="$(bashio::config 'owner_passphrase')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${OWNER_PASSPHRASE}" = "null" ] && OWNER_PASSPHRASE='kvmlab1'
export OWNER_PASSPHRASE

API_TOKEN="$(bashio::config 'api_token')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${API_TOKEN}" = "null" ] && API_TOKEN=''
export API_TOKEN

RATE_LIMIT="$(bashio::config 'rate_limit')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "${RATE_LIMIT}" = "null" ] && RATE_LIMIT='on'
export RATE_LIMIT

AUTO_LOGIN="$(bashio::config 'auto_login')"
[ "${AUTO_LOGIN}" = "null" ] && AUTO_LOGIN='true'
export INGRESS_AUTO_LOGIN="${AUTO_LOGIN}"

export PORT=8108

# The corpus lives on /data because that is the only add-on path Supervisor
# persists across an update and includes in a Home Assistant backup. Anywhere
# else and the first update silently empties the node.
export DB_PATH=/data/digger.db
export MIGRATIONS_DIR=/app/migrations

# State, not config: whether the file already exists is the difference between
# "first boot" and "your corpus is still here", and it is the single most useful
# line in this log when something has gone wrong.
if [ -f "${DB_PATH}" ]; then
  bashio::log.info "corpus found at ${DB_PATH} ($(wc -c < "${DB_PATH}") bytes)"
else
  bashio::log.info "no corpus at ${DB_PATH} yet — migrations will create it"
fi

if [ -z "${OWNER_PASSPHRASE}" ] && [ -z "${API_TOKEN}" ]; then
  # Ingress still puts Home Assistant's own login in front, but the mapped port
  # does not. Saying so is better than a silently open corpus.
  bashio::log.warning "no owner_passphrase and no api_token: this node is OPEN on port 8108"
fi

if [ "${INGRESS_AUTO_LOGIN}" = "true" ]; then
  bashio::log.info "auto_login on — the sidebar signs in via Home Assistant; port 8108 still requires a credential"
fi

bashio::log.info "Digger Node starting on port 8108"
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/src/server.ts
