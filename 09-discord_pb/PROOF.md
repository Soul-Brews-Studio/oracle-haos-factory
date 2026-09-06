# v0.1.8 — live Gateway in, PocketBase realtime out (2026-09-06)

**PASS — local fixtures only. STOP before deployment.** No kvmlab1 source,
options, restarts, tokens, or live Discord messages were changed in this task.
Scope is `09-discord_pb/` on `lab/01-discord-pb-kvmlab1`.

```text
Python: 83 tests OK (14 fake Gateway protocol/regression tests)
Live ingest: 38 assertions PASS
DC API helper: 35 assertions PASS
Bun SDK/CLI: 12 pass, 0 fail, 37 expects
Strict TypeScript; JS syntax; Python compile; ShellCheck; diff checks: PASS
Docker linux/arm64 and linux/amd64 builds: PASS
LOCAL PROOF PASS
LIVE PROOF PASS
REALTIME PROBE PASS channel=Straße create update thread-filter tombstone
PANEL PROOF PASS: liveCreate=true, liveUpdate=true, liveTombstone=true
```

### What the proof actually exercises

- Default image `/init` starts the new legacy s6 `discord-gateway` service;
  `live:false` publishes fresh disabled status while PB/poller continue normally.
- Token-free fake HTTP `/gateway/bot` + real WebSocket HELLO/IDENTIFY/READY,
  independent heartbeat/ACK, disconnect and accepted-sequence RESUME. Unit
  cases additionally cover missing ACK, partial frame timeout, aggregate frame
  bounds, saturated queue/no sequence hole, invalid-session queued-READY race,
  fatal closes, identify quota, bootstrap retry and fixture-token rejection.
- The listener calls **actual PB JSVM** ingestion under the effective YAML model.
  Selected create/partial edit/delete are stored; an unselected thread message
  is not. Invalid external YAML cannot reuse a cached allow set.
- Deletes create durable tombstones (including unknown prior messages); duplicate
  Gateway CREATE and stale REST replay cannot undo edits or resurrect deletes.
  The message schema is unchanged. Partial message fields and JSON values survive
  JSVM round trips; Node fixtures mimic PB JSONRaw byte wrappers, and a separate
  regression compares live versus REST normalization field-by-field.
- A message is created in the token-free REST fixture with **no Gateway dispatch**.
  Disconnect wakes the real serialized poller; its `after=` sweep imports exactly
  one missing row and advances only the relevant REST high-water mark. Synthetic
  records, fixture changes, cursor and model are restored after the probe.
- Actual authenticated PB SSE emits create/update/tombstone records. The Bun SDK
  name handle subscribes to real PB (not mocked fetch), filters out child-thread
  records for a parent handle, and cleans up its synthetic messages.
- Browser simulated ingress now streams rather than buffering SSE. The panel
  prepends a create without Refresh, replaces an update without duplicate rows,
  and marks a tombstone. Initial subscription and reconnect refresh snapshots
  to close SSE gaps. Model save/reload, mobile layout, and auth-isolation proofs
  still pass; 214 fixture rows remain, both Petkeeper storage sentinels unchanged.
- Independent high-risk review: **APPROVE** after fixing per-event model process
  overhead (validated private cache), Gateway lifecycle races and UI subscription
  gap. Cache keys include exact YAML and current model-relevant entity metadata.
- Source SQLite main/WAL/SHM SHA256 unchanged. No source DB, neighbour add-on,
  other listener, or live token store was modified.

ARM64 ran the full container, SDK and browser fixture. AMD64 was built and the
pinned PB version checked under emulation; native AMD64 runtime was not tested.
The fixture is **not** a live Discord or real Supervisor-ingress claim. A lost
Gateway session still cannot reconcile historical edits/deletions through an
`after=` REST poll. Nat must enable the Atlas Oracle app's privileged **Message
Content Intent** before lead deployment.

Images:

```text
arm64 sha256:df983504f46cb4ebc7046a0983ee316751a6e37b1420dd6c3817b5ef8cc442f9
amd64 sha256:eff4a8c88e09bc3b21b69603a775a3453d5c143d49ecbb52bf52979edf051f61
```

Evidence: [verification](evidence/dc-v0.1.8-verification.txt),
[local/Gateway/SDK proof](evidence/dc-v0.1.8-local.txt),
[admin browser](evidence/dc-v0.1.8-browser.txt),
[panel live updates](evidence/dc-v0.1.8-panel.txt),
[ARM64](evidence/dc-v0.1.8-build-arm64.txt),
[AMD64](evidence/dc-v0.1.8-build-amd64.txt).
Reproduce with `just verify`, the two README build commands, then
`./tests/local-proof.sh --keep`, `./tests/browser-proof.sh`, and
`./tests/panel-proof.sh`. Bun is required by the SDK probe; ego-browser by browser
proofs. The exact rsync/update/restart and merge-safe options patch are in
[README.md](README.md#lead-only-deployment-handoff-not-executed-by-this-task).

---

# v0.1.7 — declared channel model and handle API (2026-09-06)

**PASS — committed source/local fixtures only; STOP before deployment.**
No kvmlab1 options, files, service state, or Discord messages were changed in
this task. All source changes are under `09-discord_pb` on the lab branch.

Fresh gates:

```text
Python: 68 tests OK (19 strict YAML model tests included)
Bun SDK/CLI: 7 pass, 0 fail, 25 expect() calls
DC API helper: 35 assertions passed
TypeScript strict SDK typecheck: PASS
JS syntax, Python compile, Bash syntax, ShellCheck, git diff --check: PASS
Docker linux/arm64 build: PASS
Docker linux/amd64 build: PASS
Default-entrypoint ARM64 local fixture: LOCAL PROOF PASS
Real PocketBase browser: auth refresh 200, records 200, 214 fixture messages
Panel browser: PANEL PROOF PASS
```

Re-run static gates with Python/PyYAML available (local proof used an isolated
venv, not a system install), plus Bun, Node, TypeScript and ShellCheck:

```bash
python3 -m venv /tmp/discord-pb-model-tests
/tmp/discord-pb-model-tests/bin/pip install PyYAML
PATH=/tmp/discord-pb-model-tests/bin:$PATH just verify
# Build commands and local harness remain documented below.
./tests/local-proof.sh --keep
./tests/browser-proof.sh
./tests/panel-proof.sh
```

## New proof coverage

- Guild discovery lists a new thread without importing it. Initial options seed
  selection once; deselection/model policies win over old options. Unsupported
  channel types are rejected by model, initial seed, select and import gates.
- Real PB list/read/name APIs: parent 205 messages, thread 3; proper date bounds;
  ambiguous/missing names fail loudly; all `/api/dc/*` registrations require auth.
- Invalid YAML, unknown names/actions, ambiguity, aliases, duplicate keys and
  oversized documents are rejected. Failed saves leave the old file unchanged.
- Wildcard defaults survive row edits and apply to future discovered threads;
  concurrent row edits are serialized. ID-bound exports survive renamed entities.
- Model policy overrides permissive legacy options; post and action grants are
  independent. Gated post/thread/pin/archive reach **only a token-free local HTTP
  fixture**. Pin uses the current message-pins endpoint. Writes are never retried.
- Explicit channel import completes without altering polling selection. Successful
  request acknowledgements are version-qualified; failures remain retryable.
- Browser: 509 discovered entities/controls in four guild groups (includes a
  deliberately synthetic 502-entity pagination stress index), 20 visible messages,
  valid Model tab, row save → YAML → reload, raw YAML save → persisted bytes,
  inline invalid-YAML feedback retaining the draft; desktop/mobile no overflow.
- SDK's committed JSVM CommonJS build is generated from the TS source; parity
  tests exercise synchronous transport without fetch or URLSearchParams globals.
- Source SQLite main/WAL/SHM SHA256 unchanged. No old writer/listener restarted.
- Independent targeted security/correctness review: **APPROVE**, after repairing
  initial-seed importability, reload wake-up, and raw SDK/CLI YAML download.

ARM64 image ran the complete container/browser fixture. AMD64 was built and the
pinned executable version checked during build (emulated on this ARM64 host);
this round does not claim native AMD64 runtime validation.

Images:

```text
arm64 sha256:b5f3fa3b4cda541bd4ff54598ca742d2cf35ac315743cec5f81237b3b1794d7e
amd64 sha256:0bf9f1a498fe11c3477607b6cf6e6d0e354aaace8f6379c568557d5a7d9e6a97
```

Evidence: [verification](evidence/dc-v0.1.7-verification.txt),
[container/API/model proof](evidence/dc-v0.1.7-local.txt),
[browser](evidence/dc-v0.1.7-browser.txt),
[Model tab](evidence/dc-v0.1.7-panel.txt),
[ARM64 build](evidence/dc-v0.1.7-build-arm64.txt),
[AMD64 build](evidence/dc-v0.1.7-build-amd64.txt).
Screenshots: [desktop](evidence/panel-desktop.png),
[mobile](evidence/panel-mobile.png), [admin](evidence/admin-ingress.png).

Deployment commands and merge-safe options are in [README.md](README.md).
Mind map and oracle notes are next-round scope. API write success is not a claim
of immediate PB ingestion, and two-request text-channel thread creation is not
atomic. Historical archive parity is not implied by these fixture results.

---

# Local proof — 2026-09-06

## Reverse entity/name index — v0.1.3

The fixture now exposes one guild with two text channels and one thread. The
local proof resolves the guild by `Proof Guild`, exercises guild/channel/active
thread discovery, and proves the resulting private
`discord_entities` records retain names plus exact IDs. Unit coverage includes
exact-case preference, case-insensitive matching, ambiguity, and missing-name
failures. `discord_messages` was not changed. The v0.1.3 archive response was
empty and did not prove archived-only or next-poll discovery; the v0.1.6 audit
below supplies that missing evidence.

## Sidebar auto-login follow-up — v0.1.2

The existing container and browser harnesses were rerun after the ingress
identity changes. The container proof now covers: auto-login off; forged/direct
requests denied; a denied ingress user receiving its HA ID/name and the exact
`auto_login_ha_user_ids` option; an explicitly allowlisted user; and the
opt-in `auto_login_ha_admins` path with an empty allowlist. Both new options
remain false by default. See
[`docs/sidebar-autologin-lessons.md`](docs/sidebar-autologin-lessons.md) and
[`evidence/sidebar-autologin-v0.1.2.txt`](evidence/sidebar-autologin-v0.1.2.txt).

The existing real PocketBase browser proof also passed:

```json
{
  "refreshStatus": 200,
  "protectedRecordsStatus": 200,
  "records": 214,
  "petkeeperAuthUnchanged": true,
  "petkeeperFileUnchanged": true,
  "discordKeyPresent": true,
  "ingressPrefixPreserved": true
}
```

This is still a local HA-shaped ingress fixture, not a claim that v0.1.2 has
been rebuilt or restarted on kvmlab1.

**Result: PASS at the pre-install gate.** This proves local fixture behavior,
not live Discord, real HA ingress, or parity for all 263,631 source messages.

Implementation commit: `9330c8981c7c4b092f7be3e75d2c8a91a7123964` (review base `14edd8e`).
All changed files remain inside `09-discord_pb/` on `lab/01-discord-pb-kvmlab1`.
Independent reviewer: APPROVE; zero critical/high findings after fixes.

## Requested fixes

| Requirement | Implementation and proof |
|---|---|
| Persisted high-water mark | `/data/backfill-state.json`, temp+fsync+rename; lock; per-channel commit only after successful sweep |
| First `before=`, subsequent `after=` only | Both architecture integration logs below; second run zero inserts; >100 incremental unit test |
| Interrupted channel cannot skip stored/unstored messages | Mid-historical/mid-incremental failure tests leave mark unchanged; failed atomic replace leaves old file |
| Channel-only metadata | GET channel object; normal + thread context tests, deliberately absent/poisoned message routing fields |
| Storage isolation | Compiled binary and hook use `__dc_superuser_auth__`; file-token key also isolated; default auto-login false |
| Real admin behavior | Browser logged in through prefixed ingress stand-in; token refresh + protected records both HTTP 200; Petkeeper sentinels unchanged |
| Scope/gates | No Supervisor installation or production mutations. No real Discord token fetched, stored or used. Nat still supplies options later. |

## Builds and runtimes

```sh
docker build --platform linux/amd64 --build-arg BUILD_ARCH=amd64 -t discord-pb:proof-amd64 .
docker build --platform linux/arm64 --build-arg BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.22 --build-arg BUILD_ARCH=aarch64 -t discord-pb:proof .
./tests/local-proof.sh --image discord-pb:proof-amd64
./tests/local-proof.sh --keep
./tests/browser-proof.sh
```

All commands exited 0. amd64 runtime ran under local QEMU on an arm64 host;
this is **not native amd64 hardware validation**. Both ran the default image
entrypoint (`/init` → `/run.sh` → service → own scheduled backfill), not a bare
PocketBase stand-in. Retained local runs were stopped and removed after evidence.

```text
amd64 sha256:be03062f1f25dcd0ef462bba87d4e39556f638d4c80c0f4805fac47a4c843fbb
arm64 sha256:cc70afd247cd33654cb776d994eba77e5c30270b7725b9d36c31014ff95a67be
pocketbase version 0.29.3
```

Upstream ZIP SHA256 pins are checked before a fail-closed equal-length binary
patch. Raw byte checks after patch:

```text
__pb_superuser_auth__: 0
__dc_superuser_auth__: 1
pb_superuser_file_token: 0
dc_superuser_file_token: 1
```

Full logs: [amd64 build](evidence/build-amd64.txt), [arm64 build](evidence/build-arm64.txt),
[amd64 runtime](evidence/docker-proof-amd64.txt), [arm64 runtime](evidence/docker-proof-arm64.txt).

## Tests and static verification

`python3 -m unittest discover -s tests -p 'test_*.py' -v` (exit 0):

```text
----------------------------------------------------------------------
Ran 19 tests in 0.071s

OK
```

[Exact test output](evidence/tests.txt). `just verify` also passed (real branch
commits, tests, Bash syntax, ShellCheck, diff whitespace). All PB hooks/migrations
passed `node --check`.

Coverage includes 205 historical + 205 incremental messages, active-WAL recovery,
invalid/corrupt state, atomic replace and concurrent lock refusal, channel failure
continuation, 429/403/5xx, malformed PB responses, invalid input, rollback, edits,
restart persistence and ingress denial/allow cases. Deliberate failure scenarios
in the test log are expected assertions, not failed test cases.

## Exact second-run / verify evidence

```sh
CHANNELS=1485581352354054215,1500433583255457863,1515643997828153476 \
PB_URL=http://127.0.0.1:59731 \
SQLITE_DB=/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite \
./verify.sh
```

```text
{"after": "1486300828200599602", "channel_id": "1485581352354054215", "mode": "incremental", "request": "/channels/1485581352354054215/messages?limit=100&after=1486300828200599602"}
{"channel_id": "1485581352354054215", "high_water": "1486300828200599602", "inserted": 0, "mode": "incremental", "pages": 0, "updated": 0}
{"after": "1539118920718352405", "channel_id": "1500433583255457863", "mode": "incremental", "request": "/channels/1500433583255457863/messages?limit=100&after=1539118920718352405"}
{"channel_id": "1500433583255457863", "high_water": "1539118920718352405", "inserted": 0, "mode": "incremental", "pages": 0, "updated": 0}
{"after": "1516624167909458013", "channel_id": "1515643997828153476", "mode": "incremental", "request": "/channels/1515643997828153476/messages?limit=100&after=1516624167909458013"}
{"channel_id": "1515643997828153476", "high_water": "1516624167909458013", "inserted": 0, "mode": "incremental", "pages": 0, "updated": 0}
{"channels": 3, "complete": true, "failures": [], "inserted": 0, "updated": 0}
channel_id sqlite pocketbase result
1485581352354054215 1 1 OK
1500433583255457863 2 2 OK
1515643997828153476 3 3 OK
TOTAL 6 6 OK
```

The fixture loads only IDs/timestamps/channel metadata via a stable read-only
source snapshot. Content/authors are synthetic. No source DB/WAL/SHM bytes
changed. Source at proof time: **263,631 messages, 214 channels**.

The three archive-fixture channels contain **6 records**. A separate **208
synthetic messages** exercise pagination/thread/429 paths; the screenshot's
**214 records** = 6 + 208, **not** the full source archive.

## Browser proof

[Actual admin screenshot](evidence/admin-ingress.png) · [Machine checks](evidence/browser-check.json)

```json
{
  "refreshStatus": 200,
  "protectedRecordsStatus": 200,
  "records": 214,
  "petkeeperAuthUnchanged": true,
  "petkeeperFileUnchanged": true,
  "discordKeyPresent": true,
  "ingressPrefixPreserved": true
}
```

The browser opened the patched PB SPA under one local HA-shaped origin with
Petkeeper auth/file-token sentinels present. It remained authenticated through
refresh and accessed private records without touching either sentinel.

## Failures found and repaired during this run

- Original full-history-only polling and incorrect thread/guild metadata.
- Shared PB auth/file-token keys; the initial custom static-token experiment
  failed protected API validation, so final code uses a five-minute configured
  normal auth token that the real SPA demonstrably refreshes.
- Old proof bypassed actual entrypoint and did not assert second-run zero.
- Immutable source reads ignored WAL; new verifier recovers only private copies.
- Harness-only issues: internal Docker network disabled published ports;
  ephemeral ports changed on restart; QEMU prepended the PB argv; ego Node ran
  outside the repo. All were fixed at the test boundary and retested, not hidden.

## Remaining limits / stop boundary

The initial proof did not include live Discord access or Supervisor installation.
Its explicit-ID-only limit is superseded by the v0.1.6 guild/thread discovery
proof below. Incremental scans do not capture old-message edits/deletions.
Count parity can legitimately differ when Discord permissions/history change;
`verify.sh` fails rather than claiming completeness. The actual HA ingress peer
and allowlisted user IDs must be validated at the future authorized install.

Signed `[37-6sep-sun2026:01-discord-pb-kvmlab1]`

## v0.1.4 — persistent sidebar and authenticated importer

Fresh local validation (2026-09-06):
- ARM64 image built with pinned PocketBase 0.29.3.
- 21 unit tests passed; shellcheck, shell syntax, JS syntax, diff checks passed.
- Default-entrypoint fixture: LOCAL PROOF PASS, 214 fixture rows, restart
  persistence, incremental replay zero inserts, source DB/WAL/SHM unchanged.
- Import API probe: guests, invalid tokens and a real regular-user token denied;
  atomic invalid batches, retry idempotence, routing/created_at and cursor preservation passed.
- Existing admin browser proof: protected records/auth-refresh 200; unrelated
  Petkeeper storage sentinels unchanged.
- New dashboard browser proof: stays on panel.html; 20 visible rows, 4 name matches;
  guest import denied, invalid batch 400, backfill status 200/queue 202;
  UI import reports **0 inserted, 1 updated** for an existing fixture message.
- Desktop 1280px and mobile 390px screenshots show no horizontal overflow.
  [Checks](evidence/panel-check.json),
  [desktop](evidence/panel-desktop.png), [mobile](evidence/panel-mobile.png).
  UI static detector ran in degraded regex mode (parser dependencies unavailable);
  browser checks and screenshot review provide the layout evidence.

Reproduce after building the proof image:
```sh
just verify
./tests/local-proof.sh --keep
./tests/browser-proof.sh
./tests/panel-proof.sh
```

These are local fixtures, not proof of live Discord backfill. At deployment
preflight kvmlab1 had no bot_token, channels, or guilds configured and zero
messages. Deployment does not inject synthetic messages, alter options, or
borrow credentials from another add-on.

### Authorized live deployment follow-up

Supervisor successfully started v0.1.4 with unchanged options; health, panel
HTML/JS/CSS and status returned 200. Guest import and backfill POSTs returned
401. The live archive remains zero messages (no token/targets configured).
Supervisor's reported ingress_url exposed a doubled slash: it joins its ingress
base with ingress_entry itself. v0.1.5 changes the entry to relative
`panel.html`, avoiding a prefix-losing redirect. No message schema change.

## Names→IDs acceptance audit — v0.1.6

`95383d6` contained the initial implementation, but was not complete against the
full requirement. This audit repaired:
- channel alias parents pointing at categories instead of guilds (migration003
  repairs existing rows; source category metadata remains in raw);
- >500-entity discovery batches, >100-candidate/Unicode name resolution, and
  unpaginated guild-name bootstrap;
- named channels resolving before their selected guild had been discovered;
- announcement/forum/media archive parents and private archive discovery;
- unescaped/repeated archive cursors and weak archived/next-poll proof.

Fresh output (PocketBase 0.29.3, ARM64 image, local fixtures only):

```text
Ran 40 tests
OK
PASS named guild: 2 channels + 1 archived thread; channel→guild/thread→channel hierarchy
PASS next guild poll re-walks and discovers a new thread; named channel works; inserted=0
PASS 502 entities: chunked upsert; later-page exact/ambiguous/Unicode/missing lookup
PASS restart persists 214 fixture rows; post-restart replay inserted=0
PASS source DB/WAL/SHM SHA256 unchanged
LOCAL PROOF PASS
PANEL PROOF PASS
```

[Full fixture output](evidence/entities-v0.1.6.txt).
`just verify` passed unit tests, shell syntax, shellcheck and diff checks.
Existing browser admin proof passed auth-refresh/protected records 200 with
214 rows and unrelated storage sentinels unchanged. Panel proof returned 5
name matches, 20 visible messages, and an idempotent fixture import. Tests also
cover archive timestamp/ID cursor pagination, repeated-cursor failure, supported
container types, private-archive permission fallback, guild-list pagination, and
repairing legacy category parents without changing message rows or raw metadata.
No changes to `discord_messages` schema. No rsync, live options change, or
restart was performed during this acceptance audit.

Operator commands after reviewing the commit (do not copy over another add-on):

```sh
SRC="$HOME/.local/state/incubate/worktrees/Soul-Brews-Studio/oracle-haos-factory/01-discord-pb-kvmlab1/09-discord_pb"
rsync -az --exclude proof-local/ --exclude __pycache__/ "$SRC/" kvmlab1.oracle.netbird:/addons/discord_pb/
ssh kvmlab1.oracle.netbird 'ha store reload && ha apps update local_discord_pb && ha apps restart local_discord_pb'
```

The update rebuilds the image so migrations/hooks are included; a restart alone
after rsync does not replace the embedded code. Commands leave options intact.
Use the names-based options example in README, preserving credentials and
existing values. Live Discord parity remains a separate credential/target and
operator-run verification gate, not a claim made by the local fixture.
