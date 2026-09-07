// Pure helpers for the central timeline (/api/dc/timeline): query validation
// and row -> event mapping. Keep immutable: PocketBase caches required modules.
// One event shape for everything that happened, whatever its source:
//   { key, kind, ts, guild_id, guild, channel_id, channel, thread_id, thread,
//     category, author_id, author, bot, text, edited, deleted, attachments,
//     reply_to, message_id, entity_id }
//
// Paging: `since`/`before` are the time WINDOW (both optional, before
// exclusive) and apply to every kind. `cursor` ("<iso ts>|<message id>") is the
// keyset cursor for the next page of messages: rows strictly older than the
// (ts, id) tuple, so messages sharing the boundary millisecond are not lost.

const SNOWFLAKE = /^\d{17,20}$/
const KINDS = Object.freeze(["message", "thread", "import"])
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100
const MAX_GUILDS = 50
const MAX_QUERY = 120
const DISCORD_EPOCH = 1420070400000

function apiError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function text(value) { return String(value == null ? "" : value).trim() }

// PocketBase stores dates as "YYYY-MM-DD HH:MM:SS.sssZ"; filters compare that text.
function pbDate(iso) { return new Date(iso).toISOString().replace("T", " ") }

function isoOrNull(value) {
  const raw = text(value)
  if (!raw) return null
  const parsed = Date.parse(raw.replace(" ", "T"))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

// Creation instant encoded in a Discord snowflake (ms since the Discord epoch).
function snowflakeTime(id) {
  const raw = text(id)
  if (!SNOWFLAKE.test(raw)) return null
  // 64-bit id >> 22 without BigInt (goja has no BigInt): drop the low 22 bits.
  const ms = Math.floor(Number(raw) / 4194304) + DISCORD_EPOCH
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function parseIso(value, key) {
  const raw = text(value)
  const parsed = Date.parse(raw)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(parsed)) throw apiError(400, `${key} must be an ISO timestamp`)
  return new Date(parsed).toISOString()
}

function validateQuery(query) {
  const q = query || {}
  const rawLimit = text(q.limit || String(DEFAULT_LIMIT))
  if (!/^\d+$/.test(rawLimit)) throw apiError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`)
  const limit = Number(rawLimit)
  if (limit < 1 || limit > MAX_LIMIT) throw apiError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`)
  const result = { limit, since: null, before: null, cursor: null, guilds: [], kinds: KINDS.slice(), q: "" }
  for (const key of ["since", "before"]) if (text(q[key])) result[key] = parseIso(q[key], key)
  if (result.since && result.before && result.since >= result.before) throw apiError(400, "since must be earlier than before")
  const cursor = text(q.cursor)
  if (cursor) {
    const parts = cursor.split("|")
    if (parts.length !== 2 || !SNOWFLAKE.test(parts[1])) throw apiError(400, "cursor must be <ISO timestamp>|<message id> from next_cursor")
    result.cursor = { ts: parseIso(parts[0], "cursor"), id: parts[1] }
    if (result.before && result.cursor.ts >= result.before) throw apiError(400, "cursor must lie inside the window")
    if (result.since && result.cursor.ts < result.since) throw apiError(400, "cursor must lie inside the window")
  }
  const guilds = text(q.guilds)
  if (guilds) {
    const ids = guilds.split(",").map(text).filter(Boolean)
    if (ids.length > MAX_GUILDS) throw apiError(400, `guilds may list at most ${MAX_GUILDS} ids`)
    for (const id of ids) if (!SNOWFLAKE.test(id)) throw apiError(400, "guilds must be Discord snowflake ids")
    result.guilds = ids.filter((id, index) => ids.indexOf(id) === index)
  }
  const kinds = text(q.kinds)
  if (kinds) {
    const list = kinds.split(",").map(text).filter(Boolean)
    for (const kind of list) if (KINDS.indexOf(kind) < 0) throw apiError(400, `kinds must be a subset of ${KINDS.join(", ")}`)
    result.kinds = KINDS.filter((kind) => list.indexOf(kind) >= 0)
  }
  const search = text(q.q)
  if (search.length > MAX_QUERY) throw apiError(400, `q must be at most ${MAX_QUERY} characters`)
  result.q = search
  return result
}

// SQL LIKE pattern with the user's text escaped; use with ESCAPE '\'.
function likePattern(search) {
  return "%" + String(search).replace(/[\\%_]/g, (c) => "\\" + c) + "%"
}

function cursorOf(event) {
  return event && event.ts && event.message_id ? `${event.ts}|${event.message_id}` : null
}

function messageEvent(row) {
  const ts = isoOrNull(row.ts)
  return {
    key: "m:" + row.message_id, kind: "message", ts,
    guild_id: text(row.guild_id) || null, guild: text(row.guild) || null,
    channel_id: text(row.channel_id) || null, channel: text(row.channel) || null,
    thread_id: text(row.thread_id) || null, thread: text(row.thread) || null,
    category: text(row.category) || null,
    author_id: text(row.author_id) || null, author: text(row.author_name) || null, bot: !!row.author_is_bot,
    text: String(row.content == null ? "" : row.content),
    edited: !!text(row.edited), deleted: !!Number(row.deleted || 0),
    attachments: Number(row.attachments) || 0, reply_to: text(row.reply_to) || null,
    message_id: text(row.message_id), entity_id: null,
  }
}

// A thread yields up to two events: created (create_timestamp, or the
// snowflake's time for threads older than Discord's 2022-01-09 field) and,
// when archived, archived at archive_timestamp.
function threadEvents(row) {
  const base = {
    guild_id: text(row.guild_id) || null, guild: text(row.guild) || null,
    channel_id: text(row.parent_id) || null, channel: text(row.channel) || null,
    thread_id: text(row.entity_id), thread: text(row.name) || null, category: null,
    author_id: text(row.owner_id) || null, author: null, bot: false,
    edited: false, deleted: false, attachments: 0, reply_to: null, message_id: null, entity_id: text(row.entity_id),
  }
  const out = []
  const created = isoOrNull(row.created) || snowflakeTime(row.entity_id)
  if (created) out.push(Object.assign({ key: "t:" + row.entity_id, kind: "thread", ts: created, text: "thread created: " + text(row.name) }, base))
  const archived = row.archived ? isoOrNull(row.archived_at) : null
  if (archived) out.push(Object.assign({ key: "ta:" + row.entity_id, kind: "thread", ts: archived, text: "thread archived: " + text(row.name) }, base))
  return out
}

// The import marker is "last import at" for an entity (markImports overwrites
// it on every batch), so the event is keyed by entity, not by time, and says so.
function importEvent(entityId, at, entity) {
  const ts = isoOrNull(at)
  if (!ts) return null
  const e = entity || {}
  return {
    key: "i:" + entityId, kind: "import", ts,
    guild_id: e.guild_id || null, guild: e.guild || null,
    channel_id: e.kind === "thread" ? (e.parent_id || null) : entityId, channel: e.kind === "thread" ? (e.parent || null) : (e.name || null),
    thread_id: e.kind === "thread" ? entityId : null, thread: e.kind === "thread" ? (e.name || null) : null, category: null,
    author_id: null, author: "backfill", bot: true,
    text: "last import of " + (e.name ? e.name : entityId),
    edited: false, deleted: false, attachments: 0, reply_to: null,
    message_id: null, entity_id: entityId,
  }
}

// The same text match the SQL applies to messages (content or author,
// case-insensitive substring), for the kinds that are filtered in JS.
function textMatches(event, search) {
  const q = text(search).toLowerCase()
  if (!q) return true
  return ((event.text || "") + " " + (event.author || "")).toLowerCase().indexOf(q) >= 0
}

function inWindow(ts, since, before) {
  if (!ts) return false
  if (since && ts < since) return false
  if (before && ts >= before) return false
  return true
}

// Newest first; ties broken by key so paging is stable. Duplicate keys collapse.
function mergeEvents(lists) {
  const seen = {}
  const out = []
  for (const list of lists) for (const event of list || []) {
    if (!event || !event.ts || seen[event.key]) continue
    seen[event.key] = true
    out.push(event)
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  return out
}

module.exports = Object.freeze({
  SNOWFLAKE, KINDS, MAX_LIMIT, DEFAULT_LIMIT, MAX_GUILDS, MAX_QUERY, DISCORD_EPOCH,
  apiError, pbDate, isoOrNull, snowflakeTime, validateQuery, likePattern, cursorOf, messageEvent, threadEvents, importEvent, textMatches, inWindow, mergeEvents,
})
