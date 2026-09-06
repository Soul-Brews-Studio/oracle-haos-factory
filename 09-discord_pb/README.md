# Discord PocketBase — `discord_pb`

A **new local HAOS add-on**: checksum-pinned PocketBase **0.29.3**, private
`discord_messages` collection, admin ingress panel, and its own Python-stdlib
Discord REST backfill. No maw-atlas code is vendored. Code and migrations ship
inside the image; database and backfill cursors persist in `/data`.

Deployment is limited to the authorized `local_discord_pb` add-on on kvmlab1.
Nat supplies the bot token through Supervisor options; missing credentials do
not cause fallback to another service’s secrets.

## Options and permissions

- `bot_token` (`password?`): no default, read only from `/data/options.json`.
  No password-manager, source-repo, environment or filesystem-token fallback.
  Missing token leaves backfill idle; PocketBase still starts.
- `channels`: comma-separated channel/thread IDs or names. Names come from
  `discord_entities`, including entities discovered by `guilds` in the same poll.
  Exact case wins, then Unicode case-insensitive exact matching across all pages.
  Missing or ambiguous names fail with candidate names and IDs. With no `guilds`,
  unknown channel names need one initial ID-based run to populate the index.
- `guilds`: comma-separated guild IDs or names. Names bootstrap from the bot's
  paginated guild list. Every poll refreshes guilds, channels, active threads,
  and paginated archives. Public archives cover text/announcement/forum/media
  parents; private archives cover text parents, falling back to joined private
  threads when MANAGE_THREADS is unavailable. Only channels the bot can access
  can be archived; permission errors fail explicitly rather than claim parity.
  Forum/media containers are indexed but only their threads carry messages.
  Guild selection walks the entire selected guild, not only named `channels`.
- `poll_minutes`: 1–10080; default 60. Runs are serialized, not overlapping.
- `admin_email` + `admin_password`: optional pair for manual admin access.
  Runtime bootstrap never puts passwords in argv or emits first-run token URLs.
  With neither, an add-on-local superuser gets a random password; configure the
  pair for manual login rather than trying to recover that generated password.
- `auto_login`: **false by default**. When true, the sidebar dashboard signs in only via trusted ingress
  and an allowed HA user. “Open PocketBase admin” reuses that session.
- `auto_login_ha_admins`: **false by default**. When true, any user admitted
  to this `panel_admin: true` ingress panel may auto-login. Supervisor does not
  send an admin boolean header; this option deliberately relies on HA's panel
  admin gate, in addition to the add-on's ingress peer/path checks.
- `auto_login_ha_user_ids`: comma-separated HA user IDs allowed superuser access;
  default empty (deny). A denied panel shows the received HA user ID/name, a copy
  button, and the exact option name so an administrator can configure it.

Port 8110 is **not published by default** (`ports: 8110/tcp: null`). If explicitly
published later, collection content still requires PocketBase superuser auth.
`/api/discord/status` intentionally exposes only totals and channel names/IDs, never
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

## Sidebar and import API (v0.1.4)

HA ingress opens `/panel.html`: recent private messages with names/IDs,
pagination and channel/thread filtering, name lookup, and explicit backfill/import
actions. The legacy root still opens PocketBase admin. Refresh the HA page after
upgrading to pick up the new ingress entry.

`POST /api/discord/import` requires a normal PocketBase **superuser** bearer token.
It accepts `{"messages": [...]}`, at most 100 normalized rows, and commits each
batch atomically. Retrying upserts by `message_id`; original `created_at`,
routing fields, and backfill cursors remain unchanged. Unknown fields and numeric
snowflakes are rejected. The UI previews the file count before an explicit import.
An import does not discover entity names: those are populated by Discord backfill.

```sh
# PB_URL is your authorized API URL; keep the short-lived token out of logs.
curl --fail-with-body "$PB_URL/api/discord/import" \
  -H "Authorization: $PB_SUPERUSER_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @batch.json
```

Minimum normalized row (IDs shown here are examples, not real archive data):

```json
{"messages":[{"message_id":"900000000000000001","channel_id":"900000000000000002","author_id":"900000000000000003","ts":"2026-09-06T00:00:00Z","content":"Example"}]}
```

Authenticated records APIs support direct reads and normal PocketBase writes;
prefer the importer for idempotence/validation. No raw SQL or database-file
endpoint is exposed. `GET /api/discord/backfill` shows job/configuration state;
`POST /api/discord/backfill` queues the configured worker (superusers only).
Repeated requests coalesce and never run concurrent workers. Without a bot token
and targets, it returns 409 and the panel explains which options are missing.

## Reverse aliases: names → exact IDs (v0.1.6)

Migration `1788667200_002_discord_entities.js` creates the requested reverse
index. PocketBase uses timestamp-prefixed migration filenames. Correction
`1788669000_003_entity_parent_hierarchy.js` repairs existing channel parents:
**thread → channel → guild**. Discord category membership stays in `raw`.
Optional PocketBase text fields return empty strings rather than JSON null.
No `discord_messages` schema or denormalized name columns were added.

The name index is refreshed on each poll, chunked at 500 entities per request.
Name resolution scans all paginated kind records to avoid silently overlooking
ambiguity after page one; Unicode casefold is done in Python, not SQLite LOWER.

Example using names (guild list must be visible to the configured bot):

```json
{
  "channels": "arra-01,mawjs-oracle",
  "guilds": "Soul Brews - Brewing for Life",
  "poll_minutes": 60,
  "auto_login": false,
  "auto_login_ha_admins": false,
  "auto_login_ha_user_ids": ""
}
```

Supply `bot_token` securely through Supervisor options; the JSON above omits
credentials. Preserve any existing option values when applying this example.
If a channel belongs to another guild, select that guild too or seed its ID.

Reference behavior was read from maw-atlas `lib/download-guild.ts`,
`lib/download-target.ts`, and `lib/discord-threads.ts` (no source copied).
[Discord guild endpoints](https://docs.discord.com/developers/resources/guild),
[channel archive endpoints](https://docs.discord.com/developers/resources/channel),
and [thread types](https://docs.discord.com/developers/topics/threads) confirm
container types and the timestamp versus joined-private snowflake cursors.
