// Shared by the loopback backfill route and the superuser import route.
// PocketBase caches required modules across handler runtimes, so keep this module immutable.

const FIELDS = [
  "message_id", "channel_id", "thread_id", "guild_id", "author_id", "author_name",
  "author_is_bot", "content", "attachments_json", "ts", "edited_timestamp", "embeds",
  "reply_to", "raw",
]
const FIELD_SET = Object.freeze(FIELDS.reduce((result, field) => {
  result[field] = true
  return result
}, {}))
const REQUIRED_SNOWFLAKES = ["message_id", "channel_id", "author_id"]
const OPTIONAL_SNOWFLAKES = ["thread_id", "guild_id", "reply_to"]
const SNOWFLAKE = /^\d{17,20}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE.test(value)
}

function validOptionalSnowflake(value) {
  return value === null || value === "" || validSnowflake(value)
}

function validOptionalString(value) {
  return value === null || typeof value === "string"
}

function validDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !isNaN(Date.parse(value))
}

function validateMessage(item) {
  if (!isObject(item)) return "message must be an object"
  const keys = Object.keys(item)
  for (const key of keys) {
    if (!FIELD_SET[key]) return `unknown message field: ${key}`
  }
  for (const key of REQUIRED_SNOWFLAKES) {
    if (key === "author_id" && item[key] === "unknown" && item.raw && (item.raw._discord_pb_deleted || item.raw._discord_pb_partial)) continue
    if (!has(item, key) || !validSnowflake(item[key])) return `${key} must be a 17-20 digit string`
  }
  for (const key of OPTIONAL_SNOWFLAKES) {
    if (has(item, key) && !validOptionalSnowflake(item[key])) return `${key} must be null, empty, or a 17-20 digit string`
  }
  for (const key of ["author_name", "content"]) {
    if (has(item, key) && !validOptionalString(item[key])) return `${key} must be a string or null`
  }
  if (has(item, "author_is_bot") && typeof item.author_is_bot !== "boolean") return "author_is_bot must be a boolean"
  if (!has(item, "ts") || !validDate(item.ts)) return "ts must be an ISO date string"
  if (has(item, "edited_timestamp") && item.edited_timestamp !== null && item.edited_timestamp !== "" && !validDate(item.edited_timestamp)) {
    return "edited_timestamp must be null, empty, or an ISO date string"
  }
  for (const key of ["attachments_json", "embeds"]) {
    if (has(item, key) && !Array.isArray(item[key])) return `${key} must be an array`
  }
  if (has(item, "raw") && item.raw !== null && !isObject(item.raw)) return "raw must be an object or null"
  return ""
}

function validateEnvelope(body) {
  if (!isObject(body)) return "request body must be an object"
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== "messages") return "expected only a messages field"
  if (!Array.isArray(body.messages)) return "messages must be an array"
  if (body.messages.length > 100) return "expected at most 100 messages"
  for (let index = 0; index < body.messages.length; index++) {
    const error = validateMessage(body.messages[index])
    if (error) return `messages[${index}]: ${error}`
  }
  return ""
}

// Discord UPDATE is a patch, including explicit empty fields. Raw merge happens
// inside the same transaction as the message_id upsert, never in the listener.
function normalizeDispatch(data, context, previous, event, now) {
  const prior = previous ? { id: previous.message_id, timestamp: previous.ts,
    author: { id: previous.author_id === "unknown" ? null : previous.author_id,
      username: previous.author_name, bot: previous.author_is_bot },
    content: previous.content, attachments: previous.attachments_json, embeds: previous.embeds,
    edited_timestamp: previous.edited_timestamp, message_reference: { message_id: previous.reply_to || null } } : {}
  const oldRaw = Object.assign(prior, previous && isObject(previous.raw) ? previous.raw : {})
  const raw = Object.assign({}, oldRaw, data)
  if (data.author) raw.author = Object.assign({}, oldRaw.author || {}, data.author)
  raw._discord_pb_live_at = now
  delete raw._discord_pb_fetched_at
  if (event === "MESSAGE_DELETE") {
    raw._discord_pb_deleted = true
    raw._discord_pb_deleted_at = raw._discord_pb_deleted_at || now
  }
  const author = raw.author || {}
  const timestamp = raw.timestamp || new Date(Math.floor(Number(raw.id) / 4194304) + 1420070400000).toISOString()
  if (!author.id && !raw._discord_pb_deleted) raw._discord_pb_partial = true
  if (author.id) delete raw._discord_pb_partial
  return {
    message_id: raw.id, channel_id: context.channel_id, thread_id: context.thread_id || null,
    guild_id: context.guild_id || null, author_id: author.id || "unknown",
    author_name: author.global_name || author.username || null, author_is_bot: !!author.bot,
    content: raw.content == null ? null : raw.content, attachments_json: raw.attachments || [],
    ts: timestamp, edited_timestamp: raw.edited_timestamp || null, embeds: raw.embeds || [],
    reply_to: (raw.message_reference || {}).message_id || null, raw,
  }
}

function stale(previous, item) {
  if (!previous) return false
  const oldRaw = previous.raw || {}, incoming = item.raw || {}
  // A REST page fetched before a live deletion/update must never resurrect it.
  if (oldRaw._discord_pb_deleted) return true
  const oldEdit = Date.parse(previous.edited_timestamp || "") || 0
  const newEdit = Date.parse(item.edited_timestamp || "") || 0
  if (oldEdit > newEdit) return true
  if (oldRaw._discord_pb_live_at && !incoming._discord_pb_live_at) {
    const fetched = Date.parse(incoming._discord_pb_fetched_at || "") || 0
    if (fetched <= Date.parse(oldRaw._discord_pb_live_at)) return true
  }
  return false
}

function recordSnapshot(record) {
  // publicExport's JSONRaw values appear as byte arrays inside Goja, even
  // though e.json marshals them correctly. Decode JSON fields explicitly.
  const result = JSON.parse(JSON.stringify(record.publicExport()))
  for (const key of ["raw", "attachments_json", "embeds"]) {
    result[key] = JSON.parse(record.getString(key) || "null")
  }
  return result
}

function writeMessage(tx, collection, item, found) {
  const record = found.length ? found[0] : new Record(collection)
  if (found.length && stale(recordSnapshot(record), item)) return false
  if (!found.length) record.set("created_at", new Date().toISOString())
  for (const name of FIELDS) if (has(item, name)) record.set(name, item[name])
  tx.save(record)
  return true
}

function upsertMessages(app, messages) {
  let inserted = 0, updated = 0
  app.runInTransaction((tx) => {
    const collection = tx.findCollectionByNameOrId("discord_messages")
    for (const item of messages) {
      const found = tx.findRecordsByFilter("discord_messages", "message_id = {:id}", "", 1, 0, { id: item.message_id })
      writeMessage(tx, collection, item, found)
      // Replays/stale rows are acknowledged as existing, not new inserts.
      if (found.length) updated++
      else inserted++
    }
  })
  return { inserted, updated }
}

function upsertDispatch(app, data, context, event) {
  let changed = false
  app.runInTransaction((tx) => {
    const collection = tx.findCollectionByNameOrId("discord_messages")
    const found = tx.findRecordsByFilter("discord_messages", "message_id = {:id}", "", 1, 0, { id: data.id })
    const previous = found.length ? recordSnapshot(found[0]) : null
    // Replayed CREATE is not an edit; it cannot undo a later Gateway UPDATE,
    // even if Discord omitted edited_timestamp from that original dispatch.
    if (event === "MESSAGE_CREATE" && previous && previous.raw &&
        previous.raw._discord_pb_live_at && !previous.raw._discord_pb_partial) return
    // The entity is authoritative for parent/thread routing, just like REST.
    const item = normalizeDispatch(data, context, previous, event, new Date().toISOString())
    const error = validateMessage(item)
    if (error) throw new Error(error)
    changed = writeMessage(tx, collection, item, found)
  })
  return changed
}

module.exports = Object.freeze({ validateEnvelope, upsertMessages, upsertDispatch, normalizeDispatch, stale })
