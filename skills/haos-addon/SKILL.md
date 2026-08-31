---
name: haos-addon
description: "Use when creating, publishing, installing, configuring, updating, or verifying a Home Assistant OS add-on in this factory. It covers the complete producer-to-consumer lifecycle and the failure gates between each stage. Trigger for requests such as 'new HAOS add-on', 'publish an add-on', 'install this add-on', 'add an option', 'update the running add-on', or 'verify an add-on release'. Do not use for provisioning the HAOS guest itself; use docs/provision-a-guest.md for that layer."
argument-hint: "<slug> [--port <port>] [--option <name>:<str|bool|int>=<default>]..."
---

# HAOS add-on — scaffold, publish, install, and prove the running artifact

This skill exists to carry the whole add-on lifecycle, not merely generate files. The
producer, registry, Supervisor, entrypoint, and application are separate layers; success at
one layer is not evidence that the next layer received the intended artifact or option.

> **Public-repository boundary:** use placeholders for guest addresses, hostnames, usernames,
> credentials, repository identifiers, and private infrastructure. Real values belong in a
> private repository or mode-`600` files, never in this skill, argv, shell history, or logs.

Run repository commands from the root of `oracle-haos-factory`.

## 1. Confirm the factory and tools

```bash
test -f repository.yaml
test -f bin/new-addon.ts
command -v bun curl git >/dev/null
bun test bin/new-addon.test.ts
git status --short
```

**Why:** the scaffold refuses to run outside an add-on store, and its tests protect the
non-negotiable manifest rules before a new directory exists. Starting from a known Git state
also prevents unrelated files from being swept into the release.

Read [`TRAPS.md`](../../TRAPS.md) before changing the generator. Traps 2–6 describe invariants
the generator deliberately makes structural: automatic boot, correct init ownership, ingress
plus an API port, `/data` persistence, safe string schemas, and the three-surface option bridge.

## 2. Scaffold from one option definition

Choose an API-safe slug (`[a-z0-9_]+`), a port, and every initial option. String options use
`str`; supported scaffold types are `str`, `bool`, and `int`.

```bash
bun bin/new-addon.ts <slug> \
  --port <port> \
  --option greeting:str=hello \
  --option debug:bool=false

ADDON_DIR="$(find . -maxdepth 1 -type d -name '[0-9][0-9]-<slug>' -print -quit)"
test -n "$ADDON_DIR"
find "$ADDON_DIR" -maxdepth 1 -type f -print | sort
```

The command creates the next numbered directory with `config.yaml`, `build.yaml`,
`Dockerfile`, `run.sh`, and `server.ts`.

**Why one definition:** each `--option` is parsed once, then the same internal object generates
all three runtime surfaces:

1. `config.yaml` default and schema — Supervisor can validate and store the value;
2. `run.sh` `bashio::config` read, `null` guard, and export — the process can receive it;
3. `server.ts` environment read — the application can apply it.

If the middle surface is absent, the Home Assistant UI shows a saved value while the process
silently uses its default. That is Trap 6. Generating the three surfaces together makes this
class of bug impossible at scaffold time instead of relying on memory.

Do not weaken the generated non-negotiables:

- prebuilt `ghcr.io/<owner>/{arch}-addon-<slug>` images for `amd64` and `aarch64`;
- `boot: auto` and `init: false` (Trap 2);
- ingress **and** `<port>/tcp` (Trap 3);
- `data:rw`, with mutable state under `/data` (Trap 4);
- `str` for strings that may be empty, never an empty `url?` default (Trap 5).

## 3. Implement and test before Supervisor

Edit the generated server and container only as needed. When adding another option later,
change the generator input or make the same atomic three-file edit described above; never add
it to only `config.yaml` or application code.

```bash
bun test bin/new-addon.test.ts
bash -n "$ADDON_DIR/run.sh"

PORT=<test-port> \
GREETING='<non-default-greeting>' \
DEBUG=true \
bun "$ADDON_DIR/server.ts" >"<local-log-file>" 2>&1 &
SERVER_PID=$!

curl -fsS "http://<local-test-address>:<test-port>/"
curl -fsS "http://<local-test-address>:<test-port>/api/health"
kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
```

Replace the sample environment variables with those generated for this add-on. Use deliberately
non-default values and assert them in `/api/health`.

**Why:** a default-value test passes whether or not configuration crossed `run.sh`. The local
server test proves application consumption; the generator test proves the Supervisor-to-process
bridge exists. `run.sh` itself needs Supervisor's `bashio::config`, so it is not expected to run
unchanged in a plain local shell. See Trap 6.

Also inspect the manifest rather than assuming generation stayed intact:

```bash
rg -n '^(image|arch|boot|init|ingress|ingress_port|ports|map|options|schema):' \
  "$ADDON_DIR/config.yaml"
rg -n 'bashio::config|^export ' "$ADDON_DIR/run.sh"
rg -n 'process\.env\.' "$ADDON_DIR/server.ts"
```

## 4. Add the add-on to CI and publish both architectures

The scaffold does not silently edit CI. Update `.github/workflows/builder.yml` so changes under
`<NN>-<slug>/**` trigger the workflow and the builder publishes that directory with the exact
image name declared in `config.yaml`.

The build invocation must have this shape for both architectures:

```text
home-assistant/builder:
  --<arch> \
  --target <NN>-<slug> \
  --image {arch}-addon-<slug> \
  --docker-hub ghcr.io/<owner> \
  --addon
```

Validate the source-to-image contract before pushing:

```bash
rg -n '<NN>-<slug>|\{arch\}-addon-<slug>|amd64|aarch64' \
  .github/workflows/builder.yml "$ADDON_DIR/config.yaml"
git diff --check
git diff -- "$ADDON_DIR" .github/workflows/builder.yml
```

Then publish through the normal reviewed Git workflow:

```bash
git add "$ADDON_DIR" .github/workflows/builder.yml
git commit -m "feat(addon): add <slug>"
git push
gh run watch --exit-status
```

**Why CI:** without a pullable `image:` Supervisor can build on the Home Assistant appliance.
That consumes host resources and can report an accepted update while leaving the old image
running. CI makes the host pull an immutable artifact instead. See Trap 1.

Do not install yet. A green workflow proves only that the producer ran, not that anonymous
Supervisor can reach what it produced. That is Trap 7.

## 5. Prove anonymous consumer reachability

The store repository and both GHCR packages must be public. Run the scaffold's anonymous check:

```bash
bun bin/new-addon.ts <slug> --check
```

Expected output for **both** architectures:

```text
amd64: 200 installable
aarch64: 200 installable
```

Interpret failures before changing anything else:

- `401 private` — the package exists but anonymous Supervisor cannot pull it;
- `404 missing` — the package name or publish result is absent;
- another code or `curl-error` — reachability itself is not proven.

**Why anonymous:** an authenticated developer pull proves developer access, not consumer access.
Supervisor clones stores and pulls images anonymously. A green CI badge plus a private package
still produces “not found” or “cannot pull” at installation. See Trap 7, including its warning
that missing package scopes can make a management API return a misleading `404`.

Stop here unless both architectures return `200`.

## 6. Add the store and install through Supervisor

Run these commands from an authorized Supervisor API client. Put the authorization header in a
mode-`600` curl config file named `<supervisor-curl-config>`; do not place a token directly in the
command line.

```bash
curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/store/repositories" \
  -H 'Content-Type: application/json' \
  --data '{"repository":"https://github.com/<owner>/<store-repo>"}'

curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/store/reload"

curl --config "<supervisor-curl-config>" -fsS \
  "<supervisor-api>/store" \
  > "<store-response-json>"

jq -r '.data.addons[]?.slug' "<store-response-json>" | rg '(^|_)<slug>$'
```

The installed slug is normally `<repository-hash>_<slug>`, derived from the store URL. Capture
the exact value as `<installed-slug>` rather than guessing it.

```bash
curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/store/addons/<installed-slug>/install"

curl --config "<supervisor-curl-config>" -fsS \
  "<supervisor-api>/addons/<installed-slug>/info" \
  | jq '{result, version: .data.version, state: .data.state}'
```

**Why read after install:** the install response proves that Supervisor accepted or attempted the
request. The subsequent info read proves whether the add-on is actually installed and which state
it reached. See Trap 1.

## 7. Configure with the complete option set

Write a mode-`600` JSON file containing **every** option, not just the field being changed:

```bash
umask 077
cat > "<full-options-json>" <<'JSON'
{
  "options": {
    "greeting": "<non-default-greeting>",
    "debug": true
  }
}
JSON
chmod 600 "<full-options-json>"
```

Replace the example fields with the add-on's complete schema. Then write, restart, and read back:

```bash
curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/addons/<installed-slug>/options" \
  -H 'Content-Type: application/json' \
  --data-binary "@<full-options-json>"

curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/addons/<installed-slug>/restart"

curl --config "<supervisor-curl-config>" -fsS \
  "<supervisor-api>/addons/<installed-slug>/info" \
  > "<installed-info-json>"

jq '{version: .data.version, state: .data.state, option_keys: (.data.options | keys)}' \
  "<installed-info-json>"
```

**Wholesale-replace warning:** treat an options write as replacing the full option set. Omitting
an unrelated key can reset or erase it. Read the current options, merge the intended change, and
POST the complete result. Keep the response in a protected file because options may contain
secrets; do not print raw values into a transcript.

**Why restart and read back:** storing configuration and applying it are different operations.
Supervisor may show the value while a missing `run.sh` bridge leaves the process unchanged. The
read-back proves Supervisor storage; the health check in the next step proves runtime consumption.
See Trap 6.

## 8. Verify the running version, configuration, and both doors

Read the expected version from source:

```bash
EXPECTED_VERSION="$(sed -n 's/^version: "\(.*\)"$/\1/p' "$ADDON_DIR/config.yaml")"
test -n "$EXPECTED_VERSION"
printf 'expected version: %s\n' "$EXPECTED_VERSION"
```

Poll the installed state; do not trust the install, restart, or update return:

```bash
for attempt in $(seq 1 60); do
  curl --config "<supervisor-curl-config>" -fsS \
    "<supervisor-api>/addons/<installed-slug>/info" \
    > "<installed-info-json>"

  if jq -e --arg version "$EXPECTED_VERSION" \
    '.data.version == $version and .data.state == "started"' \
    "<installed-info-json>" >/dev/null; then
    break
  fi
  sleep 2
done

jq -e --arg version "$EXPECTED_VERSION" \
  '.data.version == $version and .data.state == "started"' \
  "<installed-info-json>"
```

Then prove application identity and a deliberately non-default option over the stable API port:

```bash
curl -fsS "http://<guest-ip>:<port>/api/health" > "<health-json>"
jq -e \
  '.status == "ok" and .slug == "<slug>" and .options.greeting == "<non-default-greeting>"' \
  "<health-json>"
```

Open the ingress page separately. A LAN API response does not prove ingress, and a working ingress
page does not prove the published API port. That is Trap 3.

**Why version plus identity:** a command return proves a request, a `started` state proves a
container, and HTTP `200` proves something answered. Only the expected running version plus the
add-on's identity and non-default runtime option proves that the intended artifact and
configuration are live. See Traps 1, 3, and 6.

## 9. Update without mistaking acceptance for completion

Bump `version:` in `config.yaml`, make the code change, repeat Steps 3–5, and only then ask
Supervisor to update:

```bash
curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/store/reload"

curl --config "<supervisor-curl-config>" -fsS \
  "<supervisor-api>/addons/<installed-slug>/info" \
  | jq '{installed: .data.version, offered: .data.version_latest, update: .data.update_available}'

curl --config "<supervisor-curl-config>" -fsS \
  -X POST "<supervisor-api>/store/addons/<installed-slug>/update"
```

Repeat Step 8 with the new `EXPECTED_VERSION`.

**Why repeat the consumer check first:** pointing an already-installed add-on at an unreachable
tag can break that installation, not just a future one. **Why repeat the runtime read afterward:**
Supervisor's update response is not evidence that the new image started. See Traps 1 and 7.

## Completion gate

Do not report DONE until all are true:

- generator tests pass and every option exists in `config.yaml`, `run.sh`, and `server.ts`;
- CI publishes every architecture advertised by `config.yaml`;
- `bun bin/new-addon.ts <slug> --check` reports `200 installable` for both architectures;
- Supervisor info reports the expected version and `started` state;
- `/api/health` proves the expected slug and a non-default option at runtime;
- ingress and the stable API port are verified separately;
- no credentials or private infrastructure values entered git, argv, or logs.
