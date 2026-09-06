# Discord PocketBase — `discord_pb`

A **new local HAOS add-on**: checksum-pinned PocketBase **0.29.3**, private
`discord_messages` collection, admin ingress panel, and its own Python-stdlib
Discord REST backfill. No maw-atlas code is vendored. Code and migrations ship
inside the image; database and backfill cursors persist in `/data`.

**STOP before Supervisor installation or real bot-token handling.** This branch
is local proof only, not a deployed archive. Nat supplies the bot token via
Supervisor add-on options after the explicit install gate.

## Options and permissions

- `bot_token` (`password?`): no default, read only from `/data/options.json`.
  No password-manager, source-repo, environment or filesystem-token fallback.
  Missing token leaves backfill idle; PocketBase still starts.
- `channels`: comma-separated **channel AND thread IDs** to walk. No guild or
  archived-thread auto-discovery. Values may be IDs or exact names already in
  `discord_entities`; exact case wins, then case-insensitive exact matching.
  Missing or ambiguous names fail with candidate names and IDs.
- `guilds`: comma-separated guild IDs or exact names. Every poll refreshes the
  guild, its channels, active threads, and paginated public archived threads,
  upserts `discord_entities`, then walks every discovered text channel/thread.
- `poll_minutes`: 1–10080; default 60. Runs are serialized, not overlapping.
- `admin_email` + `admin_password`: optional pair for manual admin access.
  Runtime bootstrap never puts passwords in argv or emits first-run token URLs.
  With neither, an add-on-local superuser gets a random password; configure the
  pair for manual login rather than trying to recover that generated password.
- `auto_login`: **false by default**. When true, the panel opens the embedded
  admin already signed in only via trusted ingress and an allowed HA user.
- `auto_login_ha_admins`: **false by default**. When true, any user admitted
  to this `panel_admin: true` ingress panel may auto-login. Supervisor does not
  send an admin boolean header; this option deliberately relies on HA's panel
  admin gate, in addition to the add-on's ingress peer/path checks.
- `auto_login_ha_user_ids`: comma-separated HA user IDs allowed superuser access;
  default empty (deny). A denied panel shows the received HA user ID/name, a copy
  button, and the exact option name so an administrator can configure it.

Port 8110 is **not published by default** (`ports: 8110/tcp: null`). If explicitly
published later, collection content still requires PocketBase superuser auth.
`/api/discord/status` intentionally exposes only totals and channel IDs, never
message content. `/api/discord/internal/upsert` requires both loopback peer and
an ephemeral process-only credential. No other add-on or database is accessed.

Auto-login POST requires the actual ingress TCP peer (`172.30.32.2`), an ingress
path, and an `X-Remote-User-Id` admitted by the explicit allowlist or the
opt-in panel-admin policy. Forwarded-IP headers cannot bypass this check.
Responses are `Cache-Control: no-store`; auth tokens last five
minutes and the PB admin can refresh them. These are trust-boundary checks,
not proof that the real Supervisor setup has already been tested.

## Shared-origin collision — resolved locally, live gate still applies

Petkeeper's compiled PocketBase SPA uses `__pb_superuser_auth__`. HA ingress
paths share an origin, so unmodified PB add-ons share localStorage, **not**
per-path storage. The original `14edd8e` implementation therefore collided.

This add-on checksum-verifies the pinned binary, then applies equal-length,
fail-closed changes to its embedded admin assets:

| PocketBase default | Discord-only namespace |
|---|---|
| `__pb_superuser_auth__` | `__dc_superuser_auth__` |
| `pb_superuser_file_token` | `dc_superuser_file_token` |

Both the minting hook and the actual compiled SPA use the new key. A mere
landing-page key change would not fix the compiled SPA. The patch requires
exactly one occurrence of each upstream key; unexpected binaries fail the
build. Both auth and file-token namespaces are tested under one local ingress
origin with sentinel Petkeeper values left untouched. Petkeeper is never
modified. Do not enable on real HA until the install gate is explicitly opened.

## Backfill and data semantics

`discord_entities` is the reverse name index and stores `entity_id`, `kind`,
`name`, `parent_id`, `guild_id`, Discord channel type, archive state, raw
metadata, and `seen_at`. Entity IDs are unique; names are indexed but may be
ambiguous, so resolution never silently chooses between multiple exact matches.
The panel and verifier display `name — id` together. `discord_messages` remains
unchanged and normalized IDs remain its source of truth.

The channel object (`GET /channels/{id}`), not each message, supplies guild,
parent and thread identity. Thread types 10/11/12 store `channel_id=parent_id`
and `thread_id=id`; normal channels store `channel_id=id`, `thread_id=null`.
The 13 SQLite source columns are retained by name, plus edited timestamp,
embeds, reply ID and raw JSON. PocketBase represents empty text/date fields as
empty strings, boolean `author_is_bot`, and structured `attachments_json`.
`created_at` is archive insertion time; updates preserve it and routing fields.

A unique `message_id` index and atomic page transactions make replay safe.
The first completed sweep walks history with `before=`. A per-requested-channel
high-water mark in `/data/backfill-state.json` is atomically replaced only after
that channel's entire sweep succeeds. Later runs use **only `after=<last_id>`**.
An interrupted/failed sweep leaves the previous mark intact, so the next run
replays any committed pages without skipping messages. State corruption fails
closed; it does not silently restart from an empty mark. A single-run lock
prevents scheduled/manual cursor races. Per-channel failures are summarized,
other configured channels continue, and the command exits nonzero on failures.

429 body/header delays are honored without shortening; GET 5xx retries are
bounded. Incremental polling does **not** discover edits/deletions of older
messages or inaccessible/deleted channel history. Those can prevent parity
with a historical SQLite archive and must be reported, not fabricated.

## Reproducible local proof

Prerequisites: Docker, Python 3.10+, Bash. Runtime adds no third-party Python
packages. Build the chosen local image (amd64 uses `BUILD_ARCH=amd64` and the
`amd64-base` default):

```sh
docker build --platform linux/arm64 \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.22 \
  --build-arg BUILD_ARCH=aarch64 -t discord-pb:proof .
python3 -m unittest discover -s tests -p 'test_*.py' -v
./tests/local-proof.sh
```

The proof launches the image through **its actual `/init` and `/run.sh`**, with
empty bot-token options, and a tokenless local HTTP fixture. It asserts count
and message-ID parity for three small m5 channels, an `after=` second run with
zero inserts, synthetic 205-message pagination plus a three-message thread,
429 waiting, transaction rollback, edited-record preservation, persistence on
restart, and ingress admission checks. `--keep` retains just that isolated run
for a browser test and prints its loopback URL plus exact cleanup commands.
After `--keep`, `./tests/browser-proof.sh` (requires ego-browser) captures the
actual logged-in admin and checks auth refresh plus both Petkeeper sentinels.
Raw local data/logs are ignored under `proof-local/`; no transcript is committed.

This is **fixture proof, not live Discord retrieval or real Supervisor ingress**.
The source is opened only through filesystem reads: copy main+WAL with matching
before/after hashes, recover only the private copy, and never open/checkpoint the
source via SQLite. An active WAL test proves committed WAL rows are included.

```sh
CHANNELS=1485581352354054215,1500433583255457863,1515643997828153476 \
  PB_URL=http://127.0.0.1:<local-proof-port> ./verify.sh
# Or CHANNELS=all to compare the union of all parent-channel groups.
```

Verification groups **exactly by `channel_id`** on both sides—no `OR thread_id`
workaround. Select parent IDs for count parity; configure child thread IDs for
backfill separately. A mismatch exits 1; malformed/unavailable evidence exits 2.
Zero-count or malformed HTTP success bodies cannot produce a false green.

## References used (read-only)

- Lab `README.md` and independent `REVIEW.md`, maw-atlas `ref-*.md` and memory
  learnings supplied in the oracle vault; maw-atlas `lib/discord.ts`.
- `laris-co/petkeeper-oracle/haos/petkeeper_pb` and `/addons/petkeeper_pb` source
  listing on kvmlab1. No existing add-on data or options were read or changed.
- [PocketBase v0.29.3](https://github.com/pocketbase/pocketbase/tree/v0.29.3),
  [JS migrations](https://pocketbase.io/docs/js-migrations/),
  [HA ingress](https://developers.home-assistant.io/docs/apps/presentation/),
  [HA ingress identity](https://developers.home-assistant.io/docs/apps/security/).
