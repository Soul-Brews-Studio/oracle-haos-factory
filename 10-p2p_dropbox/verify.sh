#!/usr/bin/env bash
# Local disposable proof only. Never talks to Supervisor or uses deployment credentials.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=${IMAGE:-p2p-dropbox:$(docker version --format '{{.Server.Arch}}')}
PLATFORM=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")
PEER_MODE=${PEER_MODE:-host}
PROOF_DIR=${PROOF_DIR:-$(mktemp -d)}
mkdir -p "$PROOF_DIR"
TMP=$(mktemp -d)
NAME="p2p-dropbox-verify-$$"
NETWORK="${NAME}-net"
SENDER="${NAME}-sender"
EMPTY="${NAME}-empty"
cleanup() {
  docker logs "$NAME" > "$PROOF_DIR/container.log" 2>&1 || true
  docker rm -f "$EMPTY" "$SENDER" "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
# Disposable random test key never printed or checked into source/options examples.
export AUTH_KEY
AUTH_KEY=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')
AUTH_KEY="$AUTH_KEY" bun -e 'await Bun.write(process.argv[1], JSON.stringify({auth_key:process.env.AUTH_KEY,save_dir:"/share/p2p",stun_servers:[],max_file_mb:1,turn_url:"",turn_user:"",turn_pass:""}))' "$TMP/options.json"
chmod 600 "$TMP/options.json"
bun -e 'const a=new Uint8Array(196731);for(let i=0;i<a.length;i++)a[i]=(i*31+17)%256;await Bun.write(process.argv[1],a);await Bun.write(process.argv[2],"HTTP fixture: p2p_dropbox\n");' "$TMP/p2p-fixture.bin" "$TMP/http-fixture.txt"
docker network create "$NETWORK" >/dev/null
docker create --platform "$PLATFORM" --name "$NAME" --network "$NETWORK" -p 127.0.0.1::3847 "$IMAGE" >/dev/null
docker cp "$TMP/options.json" "$NAME:/data/options.json" >/dev/null
docker start "$NAME" >/dev/null
PORT=$(docker port "$NAME" 3847/tcp | sed 's/.*://')
BASE="http://127.0.0.1:$PORT"
ready=false
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1 && docker logs "$NAME" 2>&1 | grep -q 'Registered as p2p-dropbox'; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then echo 'FAIL readiness'; exit 1; fi
printf 'IMAGE %s\n' "$IMAGE"
printf '{"auth_key":""}' > "$TMP/empty.json"
docker create --platform "$PLATFORM" --name "$EMPTY" --network none "$IMAGE" >/dev/null
docker cp "$TMP/empty.json" "$EMPTY:/data/options.json" >/dev/null
docker start "$EMPTY" >/dev/null
for _ in $(seq 1 15); do
  [ "$(docker inspect -f '{{.State.Running}}' "$EMPTY")" = false ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$EMPTY")" = false ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$EMPTY")" != 0 ]
docker logs "$EMPTY" > "$PROOF_DIR/empty-auth.log" 2>&1
grep -q 'auth_key is required' "$PROOF_DIR/empty-auth.log"
echo 'STARTUP empty auth_key rejected'
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" = 401 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ws")" = 401 ]
echo 'AUTH missing key: HTTP 401; WS 401'
if [ "$PEER_MODE" = host ]; then
  SIGNAL_URL="ws://127.0.0.1:$PORT/ws" STUN_SERVERS='[]' CONNECT_TIMEOUT_MS=30000 bun dropbox/send.ts --to p2p-dropbox "$TMP/p2p-fixture.bin" > "$PROOF_DIR/send.log" 2>&1
elif [ "$PEER_MODE" = bridge ]; then
  # Independent peer container/private IP: real WebRTC over a private bridge.
  # No host UDP ports, STUN, TURN or Cloudflare; not host-NAT traversal proof.
  docker create --platform "$PLATFORM" --name "$SENDER" --network "$NETWORK" -e AUTH_KEY \
    -e SIGNAL_URL="ws://$NAME:3847/ws" -e STUN_SERVERS='[]' \
    -e CONNECT_TIMEOUT_MS=30000 --entrypoint bun "$IMAGE" \
    send.ts --to p2p-dropbox /tmp/p2p-fixture.bin >/dev/null
  docker cp "$TMP/p2p-fixture.bin" "$SENDER:/tmp/p2p-fixture.bin" >/dev/null
  docker start -a "$SENDER" > "$PROOF_DIR/send.log" 2>&1
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$SENDER")" = 0 ]
else echo 'PEER_MODE must be host or bridge' >&2; exit 1; fi
P2P_SRC=$(shasum -a 256 "$TMP/p2p-fixture.bin" | awk '{print $1}')
P2P_DST=$(docker exec "$NAME" sh -c 'find /share/p2p -type f -name "*p2p-fixture.bin" -exec sha256sum {} \;' | awk '{print $1}')
[ "$P2P_SRC" = "$P2P_DST" ]
printf 'P2P mode=%s source_sha256=%s receiver_sha256=%s MATCH\n' "$PEER_MODE" "$P2P_SRC" "$P2P_DST"
bun dropbox/upload.ts --url "$BASE" "$TMP/http-fixture.txt" > "$PROOF_DIR/upload.log" 2>&1
HTTP_SRC=$(shasum -a 256 "$TMP/http-fixture.txt" | awk '{print $1}')
HTTP_DST=$(docker exec "$NAME" sh -c 'find /share/p2p -type f -name "*http-fixture.txt" -exec sha256sum {} \;' | awk '{print $1}')
[ "$HTTP_SRC" = "$HTTP_DST" ]
printf 'HTTP source_sha256=%s receiver_sha256=%s MATCH\n' "$HTTP_SRC" "$HTTP_DST"
# Reject files larger than the configured 1 MiB on the HTTP path.
bun -e 'await Bun.write(process.argv[1],new Uint8Array(1048577))' "$TMP/too-large.bin"
if bun dropbox/upload.ts --url "$BASE" "$TMP/too-large.bin" > "$PROOF_DIR/oversize.log" 2>&1; then echo 'FAIL HTTP size bound'; exit 1; fi
echo 'LIMIT HTTP oversized upload rejected'
docker exec "$NAME" s6-svstat /run/service/p2p-server > "$PROOF_DIR/services.log"
docker exec "$NAME" s6-svstat /run/service/p2p-receiver >> "$PROOF_DIR/services.log"
[ "$(grep -c '^up ' "$PROOF_DIR/services.log")" = 2 ]
echo 'S6 server=up receiver=up'
echo 'PASS local verify; no Supervisor install; deployment auth_key unset'
