// Pure helpers for the central timeline (/api/dc/timeline): query validation
// and row -> event mapping. Keep immutable: PocketBase caches required modules.
// One event shape for everything that happened, whatever its source:
//   { key, kind, ts, guild_id, guild, channel_id, channel, thread_id, thread,
//     category, author_id, author, bot, text, edited, deleted, attachments,
//     reply_to, message_id, entity_id }

const SNOWFLAKE = /^\d{17,20}$/
const KINDS = Object.freeze(["message", "thread", "import"])
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100
const MAX_GUILDS = 50
const MAX_QUERY = 120

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

function validateQuery(query) {
  const q = query || {}
  const rawLimit = text(q.limit || String(DEFAULT_LIMIT))
  if (!/^\d+$/.test(rawLimit)) throw apiError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`)
  const limit = Number(rawLimit)
  if (limit < 1 || limit > MAX_LIMIT) throw apiError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`)
  const result = { limit, since: null, before: null, guilds: [], kinds: KINDS.slice(), q: "" }
  for (const key of ["since", "before"]) {
    const value = text(q[key])
    if (!value) continue
    const parsed = Date.parse(value)
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(parsed)) throw apiError(400, `${key} must be an ISO timestamp`)
    result[key] = new Date(parsed).toISOString()
  }
  if (result.since && result.before && result.since >= result.before) throw apiError(400, "since must be earlier than before")
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

function threadEvent(row) {
  const ts = isoOrNull(row.created)
  if (!ts) return null
  return {
    key: "t:" + row.entity_id, kind: "thread", ts,
    guild_id: text(row.guild_id) || null, guild: text(row.guild) || null,
    channel_id: text(row.parent_id) || null, channel: text(row.channel) || null,
    thread_id: text(row.entity_id), thread: text(row.name) || null, category: null,
    author_id: text(row.owner_id) || null, author: null, bot: false,
    text: (row.archived ? "thread archived: " : "thread created: ") + text(row.name),
    edited: false, deleted: false, attachments: 0, reply_to: null,
    message_id: null, entity_id: text(row.entity_id),
  }
}

function importEvent(entityId, at, entity) {
  const ts = isoOrNull(at)
  if (!ts) return null
  const e = entity || {}
  return {
    key: "i:" + entityId + ":" + ts, kind: "import", ts,
    guild_id: e.guild_id || null, guild: e.guild || null,
    channel_id: e.kind === "thread" ? (e.parent_id || null) : entityId, channel: e.kind === "thread" ? (e.parent || null) : (e.name || null),
    thread_id: e.kind === "thread" ? entityId : null, thread: e.kind === "thread" ? (e.name || null) : null, category: null,
    author_id: null, author: "backfill", bot: true,
    text: "import completed for " + (e.name ? e.name : entityId),
    edited: false, deleted: false, attachments: 0, reply_to: null,
    message_id: null, entity_id: entityId,
  }
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
  SNOWFLAKE, KINDS, MAX_LIMIT, DEFAULT_LIMIT, MAX_GUILDS, MAX_QUERY,
  apiError, pbDate, isoOrNull, validateQuery, likePattern, messageEvent, threadEvent, importEvent, inWindow, mergeEvents,
})
