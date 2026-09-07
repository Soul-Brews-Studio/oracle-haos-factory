# discord_pb — technical design

Version 0.3.4, 2026-09-07. A Home Assistant OS add-on that keeps a private
archive of every Discord server a bot can see, and shows it three ways: a
rooms view with a server-by-server sidebar, a central timeline (every server,
one clock), and one Home Assistant sidebar entry per server. This document is
the design as built and measured on kvmlab1, not a plan.

## 1. Shape

```
Home Assistant (kvmlab1, HAOS 18.2, HA 2026.8.3, 4 GB guest on kvmbox-pve1)
│
├─ sidebar entries                       (HA dashboards, iframe strategy)
│    Discord Archive  ─ ingress panel → panel.html
│    Discord Timeline ─ dc-timeline    → timeline.html
│    <server name>    ─ dc-<guild id>  → simple.html?guild=<id>   (×12)
│
└─ add-on container  local_discord_pb  (one image, four processes under s6)
     ├─ service.py      supervises PocketBase + schedules backfill.py
     │    └─ pocketbase  :8110  (ingress only; port not published)
     │         ├─ pb_hooks/*.pb.js   HTTP routes (isolated goja runtimes, pool 4)
     │         ├─ pb_hooks/lib/*.js  pure helpers, require()d per handler
     │         ├─ pb_migrations/     schema
     │         └─ pb_public/         panel, simple (rooms), timeline (static)
     ├─ backfill.py     Discord REST → PocketBase, per-channel high-water marks
     ├─ gateway.py      Discord Gateway websocket → live MESSAGE_* dispatches
     └─ ha_admins.py    HA websocket (via Supervisor) → /run/discord-pb/ha-admins.json
```

Everything the browser talks to is PocketBase behind HA ingress. Nothing
listens on the LAN. Secrets (bot token, admin password) live in Supervisor
options; the internal token shared with the gateway lives under `/run`.

## 2. Data model (PocketBase, SQLite)

| Collection | Purpose | Keys |
|---|---|---|
| `discord_messages` | one row per message; `raw` keeps the Discord object; edits update in place; deletes tombstone via `raw._discord_pb_deleted` | unique `message_id`; `(channel_id, ts)`, `thread_id`, `author_id`, **`(ts, message_id)`**, **`(guild_id, ts)`** |
| `discord_entities` | every guild, channel, thread the bot can see: `kind`, `name`, `parent_id` (thread→channel→guild), `guild_id`, `discord_type`, `archived`, `raw`, `seen_at` | unique `entity_id`; `LOWER(name)`, `parent_id`, `guild_id` |
| `dc_channel_selection` | checkbox table: which channels are imported (legacy path when no declared model) | unique `entity_id` |
| `dc_import_requests` | one-off import requests from the panel | unique `entity_id` |
| `dc_settings` | key/value JSON: `selection_initialized`, `import:<id>` (last import time), **`sidebar`** (shared UI preferences) | unique `key` |

Two facts about the entity table drive the UI:

- The alias hierarchy in `parent_id` is thread → channel → guild (migration
  003). Discord's category (type 4) is **not** in `parent_id`; it stays in
  `raw.parent_id`, and `raw.position` keeps Discord's ordering. The sidebar and
  timeline read both with `json_extract`.
- The declared model `/data/dc.config.yaml` (validated by `dc_model.py`) is the
  authority for "is this channel imported" once it exists; the checkbox table
  is the fallback. Both surfaces ask `lib/dc_api.js` (`getModel`,
  `selectedMap`) so they agree.

The two indexes in bold were added in 0.3.4 after the sidebar count query and
the timeline's `ORDER BY ts DESC, message_id DESC` became full scans during a
491-channel sweep (API >20 s, then 502).

## 3. Ingest: how rows arrive

Two producers, one contract (`lib/discord_ingest.js` `upsertDispatch`):

- **backfill.py** (scheduled by `service.py` every `poll_minutes`, or on
  demand when a hook drops `/data/backfill-request`). Per selected channel it
  walks history with `before=` until done, then only `after=<high-water>`.
  The high-water mark is replaced atomically after a channel's whole sweep
  succeeds, so an interrupted run replays committed pages instead of skipping.
  Guild discovery (channels, active and archived threads) runs first and
  tolerates 403/404 archive routes per channel (`skipped_archives` in the
  summary); a failing guild is reported and the others still run.
- **gateway.py** holds one Discord Gateway session and posts `MESSAGE_CREATE`,
  `MESSAGE_UPDATE`, `MESSAGE_DELETE(_BULK)` to the loopback-only
  `/api/discord/internal/live`. `lib/discord_live.js` stores only channels that
  are selected and importable; everything else is counted as `ignored`.

Both write the same normalized row, so a live message and a backfilled one
are indistinguishable except for `raw._discord_pb_live_at`. `import:<id>` in
`dc_settings` is a *last-import* marker, overwritten on every batch.

Selection is the only switch. Bulk selection (`tools/dc-select.ts`,
`just select-all`) goes through the same per-channel route the panel uses,
`POST /api/dc/channels/{id}/select`, so the declared model, the checkbox table
and the backfill request stay in step. Measured on kvmlab1: ~1 channel/s;
4 → 491 channels selected took the archive from 406 to 127k messages within
an hour once memory was sufficient.

## 4. Sidebar (server → category → channel → thread)

`GET /api/dc/sidebar` (superuser) returns one payload:

- `guilds[]` — every guild row with `channel_count`, `thread_count`,
  `imported_count`, `last_message_at`, and the applied preferences `open`,
  `hidden`. Order: `prefs.order` first, then name.
- `channels[]` — every non-guild entity with `category_id`, `position`,
  `discord_type`, `importable`, `selected`, `imported_count`,
  `last_message_at`. One SQL: entities LEFT JOIN messages grouped by entity,
  plus a per-guild totals query.
- `prefs` — `{hidden:[ids], open:{id:bool}, collapsed:{categoryId:bool}, order:[ids]}`
  from `dc_settings.sidebar`.
- `model_error` — the declared model's validation error when it fails, so a
  broken YAML shows as a message, not as an empty sidebar.

`POST /api/dc/sidebar` takes a patch — `hide`/`show` (lists), `hidden`/`order`
(replace), `open`/`collapsed` (per-id booleans) — validated by
`lib/dc_sidebar.js` (`mergePrefs`: snowflakes only, ≤500 ids, unknown keys
400) and pruned to guilds the archive knows. Preferences are stored on the
box and shared by every HA user of the add-on; browser storage is not used
because HA ingress paths share one origin.

The client (`pb_public/simple-tree.js` `buildSidebar`) groups channels by
guild, then by category (a category is trusted only if it belongs to the same
guild), attaches threads to their parent (orphans stay visible, last), sorts
by Discord position, and applies the prefs. `simple.js` renders a rail of
servers, collapsible sections with a hide control, a "Hidden servers"
restorer, a Servers dialog (open, sidebar, order), `?guild=` focus and
`?room=` deep link, and re-signs the 300 s superuser token every 60 s.

## 5. Timeline (every server, one clock)

`GET /api/dc/timeline` (superuser) merges three sources into one event shape
`{key, kind, ts, guild, category, channel, thread, author, text, edited,
deleted, attachments, …}`:

| kind | source | ts |
|---|---|---|
| `message` | `discord_messages` joined to entity names (channel, thread, guild, category) | message `ts`; badges from `edited_timestamp`, `raw._discord_pb_deleted`, `attachments_json` |
| `thread` | `discord_entities` kind=thread | `thread_metadata.create_timestamp`, falling back to the snowflake's time; a second `thread archived` event at `archive_timestamp` |
| `import` | `dc_settings` `import:*` | the marker's `at`; keyed by entity, labelled "last import of" because the marker is mutable |

Query contract: `since`/`before` are the time window for every kind (`before`
exclusive); `guilds`, `kinds`, `q` (LIKE-escaped, applied to text or author,
also to threads/imports in JS so counts agree); `limit` 1–200;
`cursor=<ts>|<message id>` is a **keyset** cursor — rows strictly older than
the tuple — so messages that share a millisecond are never skipped
(PocketBase stores `ts` at millisecond precision; Discord bursts collide).
Threads and imports are clipped to the same time slice as the page's
messages (`slice` in the response), so appended pages stay chronological.
`system` (first page only) carries the gateway live status and the last
backfill job.

The client (`timeline.js`, `timeline-model.js`) keeps one request identity per
load (older responses are dropped, in-flight requests aborted), debounces the
search, holds the realtime subscription across filter changes (filters live
in a ref), re-signs the token before each connect, and merges pages with a
key-based sort. Live rows come from PocketBase realtime on
`discord_messages/*`, resolved to names with the sidebar payload, and are
subject to the same window, server, kind and text filters as loaded rows.

Verified on kvmlab1: a full keyset walk of the archive returned every message
exactly once in order; three same-millisecond rows across a page cut were
all returned; category resolution matched the sidebar for every event.

## 6. Home Assistant integration

- **Ingress.** The add-on registers one panel (`panel_admin: true`,
  `ingress_entry: panel.html`). HA 2026.8 serves it at `/<slug>`; the old
  `/hassio/ingress/<slug>` route is a plain 404. Supervisor proxies
  `/api/hassio_ingress/<token>/…` with the user's id in `X-Remote-User-Id`.
- **Auto-login.** `POST /api/discord/admin-token` mints a 5-minute PocketBase
  superuser token for a trusted ingress request. `panel_admin` only hides the
  sidebar entry; any HA user can mint an ingress session, so "admin" is
  decided by `ha_admins.py`: it reads `config/auth/list` from HA core through
  Supervisor (`homeassistant_api: true`) every 5 minutes and writes owner and
  `system-admin` ids to `/run/discord-pb/ha-admins.json`; the hook denies when
  the file is missing, stale (>15 min) or does not list the user. Proved with
  a temporary non-admin HA user: `403 HA user is not an administrator`.
- **Per-server entries.** `tools/ha-sidebar.ts` uses HA's dashboard websocket
  API (`lovelace/dashboards/create`, `lovelace/config/save` with the `iframe`
  strategy, `lovelace/dashboards/update show_in_sidebar`, `delete`) to keep
  one storage dashboard `dc-<guild id>` per server pointing at
  `<ingress entry>/simple.html?guild=<id>`, and `dc-timeline` for the
  timeline. `sync` mirrors the add-on's hidden list into `show_in_sidebar` and
  never touches dashboards it did not create. No restart, no YAML.
- **Caveat.** An iframe under `/api/hassio_ingress/` is served only while the
  browser holds a live `ingress_session` cookie (created when any add-on panel
  is opened, 15 minutes after the last validation). The embedded pages
  re-validate it every 60 s through the parent frame's `hass` while open.

## 7. Operations

`09-discord_pb/justfile` is the runbook. Coordinates come from the
environment (`DC_BOX`, `DC_HA_USER`, `DC_HA_PASSFILE`, `DC_PYTHON`); no
password reaches argv.

| recipe | what |
|---|---|
| `test` / `verify` | node + python unit tests, `node --check`, `py_compile`, `bash -n`, shellcheck |
| `push` / `deploy` | rsync to `/addons/discord_pb`, `ha store reload`, update when the version changed or rebuild when not, start once installed, read the running version back |
| `status` / `logs` / `options` / `set-option` | read the box; options are edited on the box and posted back whole (Supervisor replaces the object) |
| `select-status` / `select-all` / `select-none` | bulk selection through the add-on's own route |
| `sidebar-*` | HA entries: `servers`, `list`, `sync`, `pin`, `pin-timeline`, `hide`, `show`, `unpin` |

Runtime facts that shaped the code:

- PocketBase runs every hook handler in an isolated goja runtime; a helper
  defined at a hook file's top level is undefined inside handlers and the
  API masks the resulting 500. Shared code lives in `pb_hooks/lib`.
- JSON fields read back as bytes; use `record.getString()` then parse.
- The default hook runtime pool (15) plus a bulk sweep pushed PocketBase to
  ~300 MB RSS; on the original 2 GB guest the kernel OOM-killed it twice and
  the box thrashed (swap full, load 28). `--hooksPool=4`
  (`DISCORD_PB_HOOKS_POOL`), the Supervisor watchdog, and 4 GB of guest RAM
  fixed it; during the sweep the container sits around 300 MB.
- Superuser tokens live 300 s. Every long-running client (rooms view,
  timeline, bulk tools) re-mints before that.
- Supervisor caches add-on metadata by version: any `config.yaml` change needs
  a version bump; hooks and UI are baked into the image, so a restart never
  loads new code — `deploy` does.

## 8. Security model

- Trust boundary is the ingress TCP peer (`172.30.32.2`) plus the HA-supplied
  user id, then the HA admin list. Forwarded-IP headers are ignored.
- Every archive read and write route is `requireSuperuserAuth`. The name
  lookup (`/api/discord/entities/{name}`) requires it too since 0.2.1.
- Discord writes (`post`, `thread`, `pin`, `archive`) are allowed only by the
  declared model's per-channel policy or, without a model, by
  `allow_post` + `post_channels`.
- Internal routes (`/api/discord/internal/*`) accept loopback only with the
  per-boot token from `/run/discord-pb/internal-token`.
- Port 8110 is not published. Bot token never leaves Supervisor options and
  the backfill/gateway process environment.

## 9. Known limits

- Import events are "last import" markers, not a log; a real import log would
  need its own collection.
- Threads and imports are read whole and filtered in JS (hundreds today; fine
  to a few thousand).
- Discord permission changes (channels the bot loses) surface as `403` skips
  in the backfill summary, not as UI state.
- Screenshots of the UI are absent from the evidence; the browser used for
  verification could not capture, so the evidence is DOM assertions.
- `post_channels` name resolution accepts unique substrings; ids are safer.

## 10. Evidence

`evidence/sidebar-v0.2.0-kvmlab1-browser.txt`, `evidence/sidebar-v0.2.1-kvmlab1.txt`,
`evidence/timeline-v0.3.0-kvmlab1.txt`, `evidence/timeline-v0.3.1-review-fixes.txt`,
and `PROOF.md` (sections v0.2.0 onward). Two adversarial review rounds
(44 and 41 agents) produced 26 confirmed findings; all are fixed in the
versions named above.
