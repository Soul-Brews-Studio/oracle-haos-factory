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

function upsertMessages(app, messages) {
  let inserted = 0
  let updated = 0
  // A page commits atomically. Retried pages are safe after disconnects or restarts.
  app.runInTransaction((tx) => {
    const collection = tx.findCollectionByNameOrId("discord_messages")
    for (const item of messages) {
      const found = tx.findRecordsByFilter("discord_messages", "message_id = {:id}", "", 1, 0, { id: item.message_id })
      const record = found.length ? found[0] : new Record(collection)
      if (!found.length) record.set("created_at", new Date().toISOString())
      for (const name of FIELDS) {
        if (has(item, name)) record.set(name, item[name])
      }
      tx.save(record)
      if (found.length) updated++
      else inserted++
    }
  })
  return { inserted, updated }
}

module.exports = Object.freeze({ validateEnvelope, upsertMessages })
