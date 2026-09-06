// Pure helpers for the per-server sidebar: preference validation/merging and the
// guild summary. Keep this module immutable: PocketBase caches required modules.
// Preferences live in dc_settings under key "sidebar" and are shared by every
// Home Assistant user of this add-on (one owner, one box).

const SNOWFLAKE = /^\d{17,20}$/
const MAX_IDS = 500
const EMPTY = Object.freeze({ hidden: [], open: {}, collapsed: {}, order: [] })

function ids(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of guild or category ids`)
  if (value.length > MAX_IDS) throw new Error(`${label} may hold at most ${MAX_IDS} ids`)
  const out = []
  for (const item of value) {
    if (typeof item !== "string" || !SNOWFLAKE.test(item)) throw new Error(`${label} contains a non-snowflake id`)
    if (out.indexOf(item) < 0) out.push(item)
  }
  return out
}

function flags(value, label) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must map ids to true/false`)
  const keys = Object.keys(value)
  if (keys.length > MAX_IDS) throw new Error(`${label} may hold at most ${MAX_IDS} ids`)
  const out = {}
  for (const key of keys) {
    if (!SNOWFLAKE.test(key)) throw new Error(`${label} contains a non-snowflake id`)
    if (typeof value[key] !== "boolean") throw new Error(`${label}.${key} must be true or false`)
    out[key] = value[key]
  }
  return out
}

// Stored value -> canonical prefs. Unknown or damaged storage yields the empty
// prefs rather than an error: a broken preference must never hide the archive.
function normalizePrefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { hidden: [], open: {}, collapsed: {}, order: [] }
  const safe = (fn, input, label) => { try { return fn(input, label) } catch (_) { return fn(undefined, label) } }
  return {
    hidden: safe(ids, value.hidden, "hidden"),
    open: safe(flags, value.open, "open"),
    collapsed: safe(flags, value.collapsed, "collapsed"),
    order: safe(ids, value.order, "order"),
  }
}

// Client patch -> merged prefs. Throws on malformed input (caller answers 400).
//   hidden / order : replace the whole list
//   hide / show    : add to / remove from hidden
//   open / collapsed: merge per id (false removes nothing; it records "closed")
function mergePrefs(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("JSON object required")
  const known = ["hidden", "hide", "show", "open", "collapsed", "order"]
  for (const key of Object.keys(patch)) if (known.indexOf(key) < 0) throw new Error(`unknown sidebar key: ${key}`)
  const base = normalizePrefs(current)
  let hidden = patch.hidden !== undefined ? ids(patch.hidden, "hidden") : base.hidden.slice()
  for (const id of ids(patch.hide, "hide")) if (hidden.indexOf(id) < 0) hidden.push(id)
  const show = ids(patch.show, "show")
  hidden = hidden.filter((id) => show.indexOf(id) < 0)
  const open = Object.assign({}, base.open, flags(patch.open, "open"))
  const collapsed = Object.assign({}, base.collapsed, flags(patch.collapsed, "collapsed"))
  const order = patch.order !== undefined ? ids(patch.order, "order") : base.order
  return { hidden, open, collapsed, order }
}

// Guild rows enriched with counts and the prefs that apply to them.
function guildSummary(guildRows, channelRows, messageTotals, prefs) {
  const normalized = normalizePrefs(prefs)
  const rank = {}
  normalized.order.forEach((id, index) => { rank[id] = index })
  const byGuild = {}
  for (const row of channelRows || []) {
    const bucket = byGuild[row.guild_id] || (byGuild[row.guild_id] = { channels: 0, threads: 0, imported: 0, last: "" })
    if (row.kind === "thread") bucket.threads++
    else bucket.channels++
    bucket.imported += Number(row.imported_count || 0)
    if (row.last_message_at && row.last_message_at > bucket.last) bucket.last = row.last_message_at
  }
  const totals = messageTotals || {}
  const guilds = (guildRows || []).map((row) => {
    const bucket = byGuild[row.entity_id] || { channels: 0, threads: 0, imported: 0, last: "" }
    const total = totals[row.entity_id] || {}
    return {
      id: row.entity_id, name: row.name,
      channel_count: bucket.channels, thread_count: bucket.threads,
      imported_count: Number(total.count || bucket.imported || 0),
      last_message_at: total.last || bucket.last || null,
      hidden: normalized.hidden.indexOf(row.entity_id) >= 0,
      open: Object.prototype.hasOwnProperty.call(normalized.open, row.entity_id) ? normalized.open[row.entity_id] : true,
    }
  })
  guilds.sort((a, b) => {
    const ra = rank[a.id], rb = rank[b.id]
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1
      if (rb === undefined) return -1
      return ra - rb
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
  })
  return guilds
}

module.exports = Object.freeze({ SNOWFLAKE, MAX_IDS, EMPTY, normalizePrefs, mergePrefs, guildSummary })
