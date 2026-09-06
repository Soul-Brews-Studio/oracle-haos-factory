// Pure validation/resolution helpers for the authenticated /api/dc surface.
// Keep this module immutable: PocketBase caches required hook modules.

const SNOWFLAKE = /^\d{17,20}$/
const CHANNEL_KINDS = Object.freeze(["channel", "thread"])
const THREAD_TYPES = Object.freeze([10, 11, 12])
const IMPORTABLE_TYPES = Object.freeze([0, 5, 10, 11, 12])

function assertImportable(channel) {
  if (IMPORTABLE_TYPES.indexOf(channel.discord_type) < 0)
    throw apiError(409, `${channel.name} (${channel.entity_id}) cannot be imported; select a text channel or individual thread`)
}

function apiError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function text(value) {
  return String(value == null ? "" : value).trim()
}

function candidate(row) {
  return `${row.name} (${row.entity_id})`
}

function resolveEntity(rows, value, kinds, guildId) {
  const query = text(value)
  if (!query) throw apiError(400, "channel or guild is required")
  const allowedKinds = kinds || CHANNEL_KINDS
  let candidates = rows.filter((row) => allowedKinds.indexOf(row.kind) >= 0)
  if (guildId) candidates = candidates.filter((row) => row.guild_id === guildId || row.entity_id === guildId)

  if (SNOWFLAKE.test(query)) {
    const found = candidates.filter((row) => row.entity_id === query)
    if (found.length === 1) return found[0]
    throw apiError(404, `${allowedKinds.join("/")} id ${query} not found`)
  }

  const spelling = candidates.filter((row) => text(row.name) === query)
  if (spelling.length === 1) return spelling[0]
  if (spelling.length > 1) {
    throw apiError(409, `${query} is ambiguous; candidates: ${spelling.slice(0, 20).map(candidate).join(", ")}`)
  }
  const folded = query.toLocaleLowerCase()
  const exact = candidates.filter((row) => text(row.name).toLocaleLowerCase() === folded)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw apiError(409, `${query} is ambiguous; candidates: ${exact.slice(0, 20).map(candidate).join(", ")}`)
  }
  const partial = candidates.filter((row) => text(row.name).toLocaleLowerCase().indexOf(folded) >= 0)
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw apiError(409, `${query} is ambiguous; candidates: ${partial.slice(0, 20).map(candidate).join(", ")}`)
  }
  const nearby = candidates.slice(0, 20).map(candidate).join(", ") || "none"
  throw apiError(404, `${query} not found; candidates: ${nearby}`)
}

function validateRead(query) {
  const rawLimit = text(query.limit || "50")
  if (!/^\d+$/.test(rawLimit)) throw apiError(400, "limit must be an integer from 1 to 100")
  const limit = Number(rawLimit)
  if (limit < 1 || limit > 100) throw apiError(400, "limit must be an integer from 1 to 100")
  const result = { limit }
  for (const key of ["since", "before"]) {
    const value = text(query[key])
    if (!value) continue
    const parsed = Date.parse(value)
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(parsed)) {
      throw apiError(400, `${key} must be an ISO timestamp`)
    }
    // PocketBase date filters compare against its canonical stored representation.
    result[key] = new Date(parsed).toISOString().replace("T", " ")
  }
  return result
}

function validateWrite(kind, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw apiError(400, "JSON object required")
  if (kind === "select") {
    if (typeof body.on !== "boolean") throw apiError(400, "on must be boolean")
    return { on: body.on }
  }
  if (kind === "post") {
    const content = text(body.text)
    if (!content || content.length > 2000) throw apiError(400, "text must be 1 to 2000 characters")
    return { text: content }
  }
  if (kind === "thread") {
    const name = text(body.name), starter = text(body.starter)
    if (!name || name.length > 100) throw apiError(400, "name must be 1 to 100 characters")
    if (!starter || starter.length > 2000) throw apiError(400, "starter must be 1 to 2000 characters")
    return { name, starter }
  }
  if (kind === "pin") {
    const messageId = text(body.messageId)
    if (!SNOWFLAKE.test(messageId)) throw apiError(400, "messageId must be a Discord snowflake")
    return { messageId }
  }
  if (kind === "archive") return {}
  throw apiError(400, "unsupported action")
}

function allowedToWrite(rows, channel, options) {
  if (!options || options.allow_post !== true) throw apiError(403, "Discord writes are disabled; set allow_post=true")
  const configured = text(options.post_channels).split(",").map(text).filter(Boolean)
  if (!configured.length) throw apiError(403, "Discord writes are disabled for this channel; add it to post_channels")
  const allowed = []
  for (const value of configured) allowed.push(resolveEntity(rows, value, CHANNEL_KINDS))
  if (!allowed.some((row) => row.entity_id === channel.entity_id)) {
    throw apiError(403, `Discord writes are not allowed for ${channel.name} (${channel.entity_id}); add it to post_channels`)
  }
  return true
}

function assertWritePolicy(rows, channel, verb, model, options) {
  if (model && model.exists) {
    if (!model.ok) throw apiError(400, `declared channel model is invalid: ${model.error || "validation failed"}`)
    const policy = model.channels && model.channels[channel.entity_id]
    const allowed = verb === "post" ? !!(policy && policy.post) : !!(policy && Array.isArray(policy.actions) && policy.actions.indexOf(verb) >= 0)
    if (!allowed) throw apiError(403, `${verb} is not allowed for ${channel.name} (${channel.entity_id}) by dc.config.yaml`)
    return true
  }
  return allowedToWrite(rows, channel, options)
}

function discordBase(fixture, configured) {
  if (!fixture) return "https://discord.com/api/v10"
  const base = text(configured).replace(/\/$/, "")
  if (!/^http:\/\/(localhost|127\.0\.0\.1|fixture)(:\d+)?$/i.test(base)) {
    throw apiError(500, "fixture Discord API base must be localhost")
  }
  return base
}

function modelEntities(app) {
  const result = []
  let offset = 0
  while (true) {
    const page = app.findRecordsByFilter("discord_entities", "", "kind,name,entity_id", 500, offset)
    for (const row of page) result.push({
      entity_id: row.getString("entity_id"), kind: row.getString("kind"), name: row.getString("name"),
      parent_id: row.getString("parent_id"), guild_id: row.getString("guild_id"),
      discord_type: row.getInt("discord_type"), archived: row.getBool("archived"),
    })
    if (page.length < 500) return result
    offset += page.length
  }
}

function runModel(app, operation, values) {
  const envelope = Object.assign({ operation, entities: modelEntities(app) }, values || {})
  const path = `/data/.dc-model-input-${$security.randomString(24)}.json`
  try {
    $os.writeFile(path, JSON.stringify(envelope), 0o600)
    const raw = toString($os.cmd("python3", "/app/dc_model.py", "--request-file", path).output())
    const result = JSON.parse(raw)
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean" || typeof result.exists !== "boolean") {
      throw apiError(500, "declared channel model returned an invalid response")
    }
    return result
  } catch (error) {
    if (error && error.status) throw error
    throw apiError(500, "declared channel model could not be read")
  } finally {
    try { $os.remove(path) } catch (_) {}
  }
}

function getModel(app) { return runModel(app, "get") }

function entityRows(app, guildsOnly) {
  const result = []
  let offset = 0
  const filter = guildsOnly ? "kind = 'guild'" : "kind != 'guild'"
  while (true) {
    const page = app.findRecordsByFilter("discord_entities", filter, "kind,name,entity_id", 500, offset)
    for (const row of page) result.push({
      entity_id: row.getString("entity_id"), kind: row.getString("kind"), name: row.getString("name"),
      parent_id: row.getString("parent_id"), guild_id: row.getString("guild_id"),
      discord_type: row.getInt("discord_type"), archived: row.getBool("archived"),
    })
    if (page.length < 500) return result
    offset += page.length
  }
}

function selectedMap(app) {
  const selected = {}
  let offset = 0
  while (true) {
    const page = app.findRecordsByFilter("dc_channel_selection", "on = true", "entity_id", 500, offset)
    for (const row of page) selected[row.getString("entity_id")] = true
    if (page.length < 500) return selected
    offset += page.length
  }
}

function options() {
  try { return JSON.parse(toString($os.readFile("/data/options.json"))) } catch (_) { return {} }
}

function jsonError(event, error) {
  const status = error && Number.isInteger(error.status) ? error.status : 500
  const message = status === 500 ? "channel API request failed" : String(error.message || error)
  return event.json(status, { ok: false, error: message })
}

function discord(method, path, body) {
  const config = options()
  const fixture = $os.getenv("DISCORD_PB_FIXTURE") === "true"
  const token = String(config.bot_token || "").replace(/^Bot\s+/i, "").trim()
  if (fixture && token) throw apiError(500, "fixture mode forbids bot_token")
  if (!fixture && !token) throw apiError(409, "bot_token is not configured")
  const request = { method, url: discordBase(fixture, $os.getenv("DISCORD_API_BASE")) + path, timeout: 20, headers: { "Content-Type": "application/json" } }
  if (!fixture) request.headers.Authorization = `Bot ${token}`
  if (body !== undefined) request.body = JSON.stringify(body)
  const response = $http.send(request)
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw apiError(response.statusCode === 429 ? 503 : 502, `Discord ${method} failed (HTTP ${response.statusCode})`)
  }
  return response.json || {}
}

function message(row) {
  return {
    id: row.getString("message_id"), channel_id: row.getString("channel_id"), thread_id: row.getString("thread_id") || null,
    guild_id: row.getString("guild_id") || null, author_id: row.getString("author_id"), author_name: row.getString("author_name"),
    author_is_bot: row.getBool("author_is_bot"), content: row.getString("content"), attachments: row.get("attachments_json") || [],
    timestamp: row.getString("ts"), edited_timestamp: row.getString("edited_timestamp") || null, embeds: row.get("embeds") || [],
    reply_to: row.getString("reply_to") || null, raw: row.get("raw") || null,
  }
}

module.exports = Object.freeze({
  CHANNEL_KINDS, THREAD_TYPES, IMPORTABLE_TYPES, assertImportable, SNOWFLAKE, apiError, resolveEntity, validateRead,
  validateWrite, allowedToWrite, assertWritePolicy, discordBase, modelEntities, runModel, getModel,
  entityRows, selectedMap, options, jsonError, discord, message,
})
