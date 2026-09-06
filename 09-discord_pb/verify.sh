#!/usr/bin/env bash
set -euo pipefail
PB_URL="${PB_URL:-http://127.0.0.1:8110}"
SQLITE_DB="${SQLITE_DB:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite}"
CHANNELS="${CHANNELS:?set CHANNELS to comma-separated channel ids}"

status="$(curl -fsS "$PB_URL/api/discord/status")"
rc=0
printf 'channel_id sqlite pocketbase result\n'
IFS=, read -ra ids <<< "$CHANNELS"
for channel in "${ids[@]}"; do
  expected="$(sqlite3 "file:${SQLITE_DB}?mode=ro&immutable=1" "SELECT COUNT(*) FROM discord_messages WHERE channel_id='$channel' OR thread_id='$channel';")"
  actual="$(jq -r --arg id "$channel" '[.channels[] | select(.channel_id==$id) | .count] | add // 0' <<< "$status")"
  result=OK; [ "$expected" = "$actual" ] || { result=MISMATCH; rc=1; }
  printf '%s %s %s %s\n' "$channel" "$expected" "$actual" "$result"
done
exit "$rc"
