#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -eu
DATA_DIR=/data/pb_data
mkdir -p "$DATA_DIR"

read_opt() { v="$(bashio::config "$1" 2>/dev/null || true)"; [ "$v" = null ] && v=""; printf %s "$v"; }
DISCORD_BOT_TOKEN="$(read_opt bot_token)"; export DISCORD_BOT_TOKEN
DISCORD_CHANNELS="$(read_opt channels)"; export DISCORD_CHANNELS
DISCORD_PB_AUTO_LOGIN="$(read_opt auto_login)"; export DISCORD_PB_AUTO_LOGIN
DISCORD_PB_ADMIN_EMAIL="$(read_opt admin_email)"; export DISCORD_PB_ADMIN_EMAIL
ADMIN_PASSWORD="$(read_opt admin_password)"
POLL_MINUTES="$(read_opt poll_minutes)"; [ -n "$POLL_MINUTES" ] || POLL_MINUTES=60
DISCORD_PB_INTERNAL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"; export DISCORD_PB_INTERNAL_TOKEN

if [ -n "$DISCORD_PB_ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  /pb/pocketbase superuser upsert "$DISCORD_PB_ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir="$DATA_DIR"
fi

/pb/pocketbase serve --http=0.0.0.0:8110 --dir="$DATA_DIR" --hooksDir=/pb/pb_hooks --migrationsDir=/pb/pb_migrations --publicDir=/pb/pb_public &
PB_PID=$!
trap 'kill "$PB_PID" 2>/dev/null || true; wait "$PB_PID" 2>/dev/null || true' EXIT INT TERM
until wget -qO- http://127.0.0.1:8110/api/health >/dev/null; do kill -0 "$PB_PID" || exit 1; sleep 1; done

while kill -0 "$PB_PID" 2>/dev/null; do
  python3 /app/backfill.py || bashio::log.error "backfill failed; will retry on schedule"
  sleep "$((POLL_MINUTES * 60))" & wait $! || true
done
