#!/usr/bin/env bash
set -euo pipefail
DB="${SQLITE_DB:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite}"
CHANNELS="${CHANNELS:-1485581352354054215,1500433583255457863,1515643997828153476}"
NET=discord-pb-proof
FIXTURE_PID=""
cleanup() { [ -z "$FIXTURE_PID" ] || kill "$FIXTURE_PID" >/dev/null 2>&1 || true; docker rm -f discord-pb-app >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup; docker network create "$NET" >/dev/null
SQLITE_DB="$DB" CHANNELS="$CHANNELS" python3 tests/fixture_discord.py & FIXTURE_PID=$!
until curl -fsS "http://127.0.0.1:18080/channels/${CHANNELS%%,*}/messages?limit=1" >/dev/null; do sleep .2; done
docker run -d --name discord-pb-app --network "$NET" --entrypoint /pb/pocketbase -p 18110:8110 \
  -e DISCORD_PB_INTERNAL_TOKEN=local-proof -v discord-pb-proof-data:/data discord-pb:lab \
  serve --http=0.0.0.0:8110 --dir=/data --hooksDir=/pb/pb_hooks --migrationsDir=/pb/pb_migrations --publicDir=/pb/pb_public >/dev/null
until curl -fsS http://127.0.0.1:18110/api/health >/dev/null; do sleep .2; done
APP_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' discord-pb-app)"
run_backfill() {
  docker run --rm --network "$NET" -e DISCORD_API_BASE="http://host.docker.internal:18080" \
    -e POCKETBASE_URL="http://$APP_IP:8110" -e DISCORD_PB_INTERNAL_TOKEN=local-proof \
    -e DISCORD_BOT_TOKEN=fixture-not-a-token -e DISCORD_CHANNELS="$CHANNELS" --entrypoint python3 discord-pb:lab /app/backfill.py
}
echo 'FIRST RUN'; run_backfill
echo 'VERIFY'; CHANNELS="$CHANNELS" PB_URL=http://127.0.0.1:18110 SQLITE_DB="$DB" ./verify.sh
echo 'SECOND RUN'; run_backfill
