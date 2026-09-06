# Local proof — 2026-09-06

## Reverse entity/name index — v0.1.3

The fixture now exposes one guild with two text channels and one thread. The
local proof resolves the guild by `Proof Guild`, exercises guild/channel/active
thread/archived-thread discovery, and proves the resulting private
`discord_entities` records retain names plus exact IDs. Unit coverage includes
exact-case preference, case-insensitive matching, ambiguity, and missing-name
failures. `discord_messages` was not changed.

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

No live Discord access or Supervisor install. Parent/thread IDs must be explicit;
no auto-discovery. Incremental scans do not capture old-message edits/deletions.
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
