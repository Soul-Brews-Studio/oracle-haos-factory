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
- `channels`: comma-separated channel/thread IDs or names, used **only as the initial selection** when no declared model exists. Later edits use the Model tab; restarting never re-enables a deselected channel. Names come from
  `discord_entities`, including entities discovered by `guilds` in the same poll.
  Exact case wins, then Unicode case-insensitive exact, then unique substring matching across all pages.
  Missing or ambiguous names fail with candidate names and IDs. With no `guilds`,
  unknown channel names need one initial ID-based run to populate the index.
- `guilds`: comma-separated guild IDs or names. Names bootstrap from the bot's
  paginated guild list. Every poll refreshes guilds, channels, active threads,
  and paginated archives. Public archives cover text/announcement/forum/media
  parents; private archives cover text parents, falling back to joined private
  threads when MANAGE_THREADS is unavailable. Only channels the bot can access
  can be archived; permission errors fail explicitly rather than claim parity.
  Forum/media containers are indexed but only their threads carry messages.
  Guild discovery is **list-only**. It never implicitly selects channels or threads for import.
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
an ephemeral credential shared only under /run/discord-pb. No other add-on or database is accessed.

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
bounded. Incremental polling alone does **not** discover edits/deletions of older
messages or inaccessible/deleted channel history. Those can prevent parity
with a historical SQLite archive and must be reported, not fabricated.

## Reproducible local proof

Prerequisites: Docker, Python 3.10+, Bash. Runtime adds no third-party Python
packages except the server-side PyYAML parser (`py3-yaml`). For host tests, create a venv and install `PyYAML`; otherwise run them inside the image. Build the chosen local image (amd64 uses `BUILD_ARCH=amd64` and the
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

## Simple rooms view (v0.1.10)

`/simple.html` is an additive React + Tailwind reader for the existing archive. It deliberately
leaves the operational dashboard intact: the same HA-ingress admin mint and the same add-on-local
PocketBase session are reused, then guild → channel → thread navigation appears on the left and the
selected room opens on the right. The left rail also has a collapsible **Ground truth / backfill coverage** table: its counts are the stored PocketBase facts for each discovered room, not a guessed Discord total. It uses only relative URLs, so it works under the HA ingress path.

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


## Channel handles and declared model (v0.1.7)

**List first, import by declaration.** `guilds` in the add-on options discovers
channel/thread metadata every poll; only selected channels are imported. The
`channels` option seeds the initial selection once. State persists in private
PocketBase collections under `/data/pb_data`; the authoritative editable model
is `/data/dc.config.yaml` when present. A checkbox or row save creates/updates
that model, preserving earlier import choices and wildcard defaults.

```yaml
guilds:
  "Soul Brews - Brewing for Life":
    purpose: Oracle rooms
    channels:
      "*": {import: false, post: false, actions: []}
      arra-01:
        purpose: agent room
        owner: arra-oracle
        import: true
        post: false
        actions: []
oracles:
  arra-oracle:
    home: [arra-01]
    reads: []
```

Discover names first with `guilds`; unknown or ambiguous references report
candidates rather than silently choosing. Python/PyYAML is the single model
parser. Unknown keys/actions, wrong scalar types, duplicate keys, YAML aliases,
and oversized documents are rejected. Saving binds names to quoted string IDs
so later Discord renames do not change the selected identity. The tree retains
human-readable names next to IDs. Successful saves normalize YAML formatting;
comments are not preserved. IDs must be quoted in manually written YAML.

The Model tab has a guild → channel → thread tree, per-row purpose/owner/import/
post/actions, an explicit row-save button, and a raw YAML editor with validate,
save, reload, and download-for-git. Invalid saves leave the old file unchanged.
Writes are serialized with a file lock and published by private atomic rename.
API access rereads the model, saves wake the poller, and normal polls also reload
it: **no add-on restart is needed for model changes**. An in-progress channel
sweep finishes; changes apply to the next sweep, not a cancellation mid-page.

### Authorization and write policy

Every `/api/dc/*` endpoint requires a PocketBase superuser session token, including
the token minted by the existing HA ingress login. Merely sending HA headers is
not authorization. The Discord bot token never goes to the SDK/browser.

- No model: `allow_post: false` by default. Outbound Discord writes additionally
  require the exact target in `post_channels` (IDs or unambiguous names).
- Model present: configuration wins, even over enabled option overrides.
  `post: true` grants message posting; each action (`thread`, `pin`, `archive`)
  is granted **only** by membership in `actions`, independently of `post`.
  Omitted channels/verbs are denied. Invalid models fail closed.
- Reading, selection, configuration saves, and local import requests do not
  require `allow_post`; that switch governs outbound Discord mutations.
- No parent-to-thread write permission inheritance. Wildcards apply only within
  their declared guild. Grant broad defaults deliberately, not accidentally.
- A thread action in a text/announcement channel creates a starter message then
  starts its thread. This is two Discord requests, not an atomic transaction;
  failures are surfaced and writes are never automatically retried. Posted
  content suppresses automatic mentions. A successful API response confirms
  Discord accepted the write, not that it has already been polled into PB.

### API and SDK

| Route | Result |
|---|---|
| `GET /api/dc/channels` | Names, IDs, guild/parent/kind/archive state, own imported count, selection and policy; optional `?guild=<name-or-id>` |
| `GET /api/dc/channels/{x}/read` | PB messages; `limit` 1–100, optional ISO `since` inclusive / `before` exclusive; parent reads exclude thread replies |
| `POST /api/dc/channels/{x}/select` | `{on: boolean}` updates declared import selection |
| `POST /api/dc/channels/{x}/import` | Queues that channel now, without selecting it for future polls; HTTP 202 is queue acceptance, not completion |
| `POST /api/dc/channels/{x}/post` | `{text}` |
| `POST /api/dc/channels/{x}/thread` | `{name, starter}`; starter is message text |
| `POST /api/dc/channels/{x}/pin` | `{messageId}`; verifies message belongs to the target |
| `POST /api/dc/channels/{x}/archive` | Archives a thread only |
| `GET /api/dc/channels/{x}/allowed?verb=post` | Current policy check; no Discord side effect |
| `GET /api/dc/config` / `config.yaml` | Resolved JSON / editable raw YAML |
| `POST /api/dc/config/validate` / `save` | `{yaml: "..."}` or `{config: {...}}`; validation before persistence |
| `POST /api/dc/config/channel/{id}` | Row policy patch: purpose, owner, import, post, actions |
| `POST /api/dc/config/reload` | Validate the file and wake the existing serialized poller |

Explicit import requests persist in PB with per-request IDs. Successful sweeps
ack only the observed request version; a newer queued request is not deleted.
Failures keep the request for a later attempt. Normal polling handles selected
channels; explicit channel-only jobs do not sweep every configured guild.
`GET /api/discord/backfill` exposes the existing global worker state.

See [sdk/README.md](sdk/README.md) for Bun, CLI, and synchronous PocketBase JSVM
usage. `sdk/dc.ts` is the typed source; `pb_hooks/lib/dc.js` is its committed
CommonJS build for JSVM's non-async runtime. No maw plugin is included.

### Upgrade gate (not executed)

```bash
SRC="$HOME/.local/state/incubate/worktrees/Soul-Brews-Studio/oracle-haos-factory/01-discord-pb-kvmlab1/09-discord_pb"
rsync -az --exclude proof-local/ --exclude __pycache__/ \
  "$SRC/" kvmlab1.oracle.netbird:/addons/discord_pb/
ssh kvmlab1.oracle.netbird \
  'ha store reload && ha apps update local_discord_pb && ha apps restart local_discord_pb'
```

An image update/rebuild is required; restart alone will not install new source.
Merge this non-secret example into existing options, preserving bot/admin/ingress
settings. `channels` seeds only a fresh installation; use Model for existing
selection. Neither discovery nor this example posts to Discord:

```json
{
  "guilds": "Soul Brews - Brewing for Life",
  "channels": "arra-01",
  "poll_minutes": 5,
  "allow_post": false,
  "post_channels": "",
  "auto_login": false,
  "auto_login_ha_admins": false,
  "auto_login_ha_user_ids": ""
}
```

Mind-map rendering, per-oracle notes, and a maw plugin are intentionally deferred.


Importable Discord types are text/announcement channels and threads
(`0,5,10,11,12`). Other entities still appear in the tree, but their import
controls are disabled. Initial selection, the select/import API, and effective
model policies all reject unsupported types before storing an import choice.
A wildcard `import: true` must explicitly exclude non-importable containers.

Official API contracts checked for this implementation:
[Discord messages/pins](https://docs.discord.com/developers/resources/message),
[channels and thread creation](https://docs.discord.com/developers/resources/channel),
[thread semantics](https://docs.discord.com/developers/topics/threads),
[PocketBase blocking HTTP](https://pocketbase.io/docs/js-sending-http-requests/),
and [PocketBase subprocess execution](https://pocketbase.io/jsvm/functions/_os.cmd.html).
The pin action uses the current `/channels/{id}/messages/pins/{messageId}` route.

## Live feed — v0.1.8

`live: true` (the default) runs a separate **s6-supervised Python Gateway service**.
No `discord.py` or new Python dependency is used: the bounded raw WebSocket client
is in `gateway_ws.py`. PocketBase and the REST reconciliation worker retain their
existing supervisor. `live: false` leaves Gateway idle and preserves polling.
Options load at process startup; changing the YAML model does not need restart.

**Before enabling this build on kvmlab1:** Nat must enable **Message Content
Intent** for the **Atlas Oracle** app in Discord Developer Portal → Bot →
Privileged Gateway Intents. IDENTIFY requests `GUILDS | GUILD_MESSAGES |
MESSAGE_CONTENT` (`33281`). A `4014` close is terminal and reports this setup hint;
authentication/intent failures do not retry IDENTIFY in a tight loop. Gateway
intents are separate from the bot's permissions to view individual rooms.
[Discord Gateway intent documentation](https://docs.discord.com/developers/events/gateway#message-content-intent).

Gateway `MESSAGE_CREATE`, partial `MESSAGE_UPDATE`, `MESSAGE_DELETE` and bulk
message deletes go through the same transactional `message_id` upsert as REST.
The live normalizer uses the same field mapping as backfill; field-presence
merging is transactional, so omitted update fields are retained and an empty
string remains a real edit. The effective model is re-read at each message:
only `import: true` (or persisted selection without a model) is written. Invalid
models fail closed. Unselected messages are counted, not archived.
Guild/channel/thread create/update events keep **metadata** indexed for LIST
FIRST, including unselected rooms; this does not grant message import or posting.

No message schema migration is needed. Deletions preserve the archived record
with `raw._discord_pb_deleted: true` and `_discord_pb_deleted_at`; the panel shows
“Deleted message”. An unseen deletion still creates a durable tombstone. If its
author is unknown, `author_id` is the literal **`unknown`**, never a fabricated
Discord ID. Unseen partial updates similarly use `_discord_pb_partial` until a
full message arrives. These are archive/audit records, not a claim that the
message still exists on Discord.

REST pages carry their fetch-start time. Older pages/edits cannot overwrite newer
live edits, and no replay can resurrect a tombstone. `created_at` and routing
fields remain intact. Gateway advances only its accepted dispatch sequence;
**it never advances the REST watermark**. Disconnects request a reconciliation
sweep, which uses the existing `after=` watermarks and unique index to fill new
message gaps without duplicate rows. RESUME replays retained Gateway events;
if the session expires, polling cannot recover old-message edits/deletions that
occurred offline. That limitation is unchanged and is not a parity claim.

`GET /api/dc/status` requires the existing ingress-minted **PB superuser token**
or a manual PB superuser token, like all `/api/dc/*` endpoints. It returns
`live_status` with `connected`, `session_id`, `last_event_age` (seconds/null),
`events_per_minute`, received/stored/ignored counters, and a nonsecret error.
A stale status file never reports connected. Status is private under `/data`;
the ephemeral internal ingestion credential is shared via a `0600` file in a
`0700` directory under **`/run/discord-pb`**, never committed or returned by API.

The panel receives PocketBase `/api/realtime` SSE and updates/deduplicates visible
rows immediately. Authentication occurs on the subscription request, never with
the Discord bot token. After reconnect it refreshes the list because PB SSE has
no durable replay cursor. SDK `channel(x).stream((record, action) => …)` and CLI
`bun sdk/cli.ts channel arra-01 tail` use the same SSE protocol. Parent streams
exclude child thread replies, matching `read()`; subscribe to the thread itself.
[PB realtime API](https://pocketbase.io/docs/api-realtime/),
[SDK/CLI details](sdk/README.md).

### Lead-only deployment handoff (not executed by this task)

The image changed; a restart alone does not install it. Preserve `/data` and the
existing `bot_token`, credentials and autologin choices. Example **options patch**
(not a replacement for the full existing Supervisor options object):

```json
{"live":true,"guilds":"Mini lab, Soul Brews - Brewing for Life","channels":"arra-01","poll_minutes":5,"allow_post":false,"post_channels":""}
```

```bash
SRC="$HOME/.local/state/incubate/worktrees/Soul-Brews-Studio/oracle-haos-factory/01-discord-pb-kvmlab1/09-discord_pb"
rsync -az --exclude proof-local/ --exclude __pycache__/ \
  "$SRC/" kvmlab1.oracle.netbird:/addons/discord_pb/
ssh kvmlab1.oracle.netbird \
  'ha store reload && ha apps update local_discord_pb && ha apps restart local_discord_pb'
```

No deployment, live options change, or Discord write was made during this task.


## Time-first archive — v0.1.9

The sidebar displays message creation times in **Asia/Bangkok (+07)**, with
ISO UTC on hover and relative ages refreshed every 30 seconds. Day headings are
sticky; select a guild/channel/thread and use a timeline bar or **Jump to date**
to browse history. Day/hour histograms cover the imported range, with first/last
message dates and explicit zero-message-day gaps. A gap means **no archived rows
for that day**, not proof Discord was inactive or that import is complete.
The Model tree adds first/last message dates, last-import time, and activity sort.

The existing PocketBase field is `discord_messages.ts` (exposed as `timestamp`
by the SDK). It remains the only feed/timeline clock. No message schema change.
“Imported at” is tracked separately in existing `dc_settings` rows; it updates
on committed REST/JSON batches and successful completed channel sweeps, including
empty sweeps. Gateway deliveries do not update it. Imports predating this build
show **Not recorded** until a new import; no historical time is fabricated.
“Live since” uses the current Gateway connection's READY/RESUMED time, not the
first message or import time, and disappears when the connection is stale.

Authenticated API (same ingress-minted or manual PB superuser token):

```text
GET /api/dc/channels/{id-or-name}/timeline?bucket=day
GET /api/dc/guilds/{id-or-name}/timeline?bucket=hour
```

Responses include `time_zone`, `target`, `first`, `last`, `total`, sparse nonzero
`buckets: [{start, date, label, count}]`, and zero-day `gaps` with inclusive
`since`, exclusive `before`, and `days`. Bucket starts/first/last are ISO UTC;
labels and dates use Bangkok. Parent channels exclude child-thread replies;
thread handles are exact, while guilds include their channels and threads.
Counts include retained deletion tombstones, like the archive list.

```ts
await dc.channel("arra-01").timeline({bucket: "day"});
await dc.guild("Mini lab").timeline({bucket: "hour"});
```

```sh
bun sdk/cli.ts channel arra-01 timeline --bucket day
```

**Deployment boundary:** this revision was tested locally, not deployed.
There are **no new options**. Use the rsync/update/restart commands above only
when the lead deploys; leave the existing options intact, including `live:false`
until Nat enables Message Content Intent, all four configured guilds (including
Arthur Visions and Cat Lab & Co), selections, and credentials. Do not replace
options with the older v0.1.8 example.
