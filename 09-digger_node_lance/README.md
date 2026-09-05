# `09-digger_node_lance` packaging

Local Phase 2 packaging for the unpublished Digger Node Lance app branch. It is
deliberately a sibling of `07-digger_node`: different slug, port and `/data`
volume, with no path to the existing SQLite corpus.

## Static verification

```bash
09-digger_node_lance/test-packaging.sh
git diff --check -- 09-digger_node_lance
```

## Local image build

The build must receive the clean app worktree as a named Docker context. The
helper refuses another branch or dirty source so its OCI revision label and
printed SHA cannot misrepresent what entered the image.

```bash
APP_WORKTREE="$HOME/.local/state/incubate/worktrees/Soul-Brews-Studio/digger-node/02-digger-node-lance-pb" \
PLATFORM=linux/amd64 \
09-digger_node_lance/build-local.sh
```

Equivalent explicit command:

```bash
APP="$HOME/.local/state/incubate/worktrees/Soul-Brews-Studio/digger-node/02-digger-node-lance-pb"
SHA="$(git -C "$APP" rev-parse HEAD)"
docker buildx build --load --platform linux/amd64 \
  --build-context "app=$APP" \
  --build-arg "APP_SOURCE_SHA=$SHA" \
  --build-arg BUILD_VERSION=0.1.0 \
  -t "digger-node-lance:0.1.0-amd64-${SHA:0:12}" \
  09-digger_node_lance
```

The Dockerfile runs the Bun tests/typecheck, Python tests, offline-model
preparation and a real served-asset PocketBase namespace proof as image gates.

## Local container acceptance (not an HAOS install)

Create a private options file with test-only values, then mount a new empty data
directory. Do not point either mount at another add-on's data:

```bash
mkdir -p /tmp/digger-node-lance-data
cat >/tmp/digger-node-lance-options.json <<'JSON'
{
  "instance_name": "local-lance",
  "owner_passphrase": "local-test-passphrase",
  "api_token": "local-test-bearer",
  "rate_limit": "on",
  "auto_login": false,
  "public_url": "",
  "pb_auto_login": false,
  "pb_admin_ha_user_ids": "",
  "pb_owner_email": "owner@digger.invalid",
  "pb_superuser_email": "admin@digger.invalid"
}
JSON
chmod 0600 /tmp/digger-node-lance-options.json

docker run --rm --name digger-node-lance-local \
  -p 18111:8111 \
  -v /tmp/digger-node-lance-data:/data \
  -v /tmp/digger-node-lance-options.json:/data/options.json:ro \
  "digger-node-lance:0.1.0-<platform>-<source-sha>"
```

From another terminal:

```bash
curl -fsS http://127.0.0.1:18111/health \
  | jq -e '.driver == "lancedb" and .tools == 19 and .embedder != null'
```

Stop after local verification. Do not push, publish or install this add-on
without Nat's separate approval.
