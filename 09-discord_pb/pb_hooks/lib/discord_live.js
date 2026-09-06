// No mutable module state: JSVM required helpers are cached across requests.
const SNOWFLAKE = /^\d{17,20}$/
const THREADS = [10, 11, 12]

function saveEntity(app, data, guild) {
  if (!data || !SNOWFLAKE.test(data.id || "")) throw new Error("invalid entity id")
  const found = app.findRecordsByFilter("discord_entities", "entity_id = {:id}", "", 1, 0, { id: data.id })
  const old = found.length ? JSON.parse(JSON.stringify(found[0].publicExport())) : null
  if (old) old.raw = JSON.parse(found[0].getString("raw") || "null")
  const raw = Object.assign({}, old && old.raw || {}, data)
  if (data.thread_metadata) raw.thread_metadata = Object.assign({}, old && old.raw && old.raw.thread_metadata || {}, data.thread_metadata)
  const kind = guild ? "guild" : THREADS.indexOf(raw.type) >= 0 ? "thread" : "channel"
  const gid = guild ? raw.id : raw.guild_id || old && old.guild_id || ""
  const record = found.length ? found[0] : new Record(app.findCollectionByNameOrId("discord_entities"))
  const item = { entity_id: raw.id, kind, name: raw.name || old && old.name || raw.id,
    guild_id: gid, parent_id: kind === "thread" ? raw.parent_id || "" : kind === "channel" ? gid : "",
    discord_type: guild ? -1 : raw.type, archived: !!(raw.thread_metadata || {}).archived,
    raw, seen_at: new Date().toISOString() }
  for (const key of Object.keys(item)) record.set(key, item[key])
  app.save(record)
}

function selected(app, channelId, helper) {
  const model = helper.liveModel ? helper.liveModel(app) : helper.getModel(app)
  if (!model.ok) return { on: false, reason: "invalid_model" }
  if (model.exists) return { on: !!(model.channels[channelId] && model.channels[channelId].import) }
  const rows = app.findRecordsByFilter("dc_channel_selection", "entity_id = {:id} && on = true", "", 1, 0, { id: channelId })
  return { on: rows.length > 0 }
}

function dispatch(app, event, data, helper, ingest) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("dispatch data must be an object")
  if (["CHANNEL_CREATE", "CHANNEL_UPDATE", "THREAD_CREATE", "THREAD_UPDATE", "GUILD_CREATE", "GUILD_UPDATE"].indexOf(event) >= 0) {
    // LIST FIRST metadata is always indexed. Only message bodies are gated.
    let count = 1
    app.runInTransaction((tx) => {
      const guild = event.indexOf("GUILD_") === 0
      const metadata = Object.assign({}, data)
      if (guild) { delete metadata.channels; delete metadata.threads; delete metadata.members; delete metadata.presences; delete metadata.voice_states }
      saveEntity(tx, metadata, guild)
      if (guild) for (const channel of (data.channels || []).concat(data.threads || [])) {
        saveEntity(tx, Object.assign({}, channel, { guild_id: data.id }), false); count++
      }
    })
    return { ok: true, stored: count, ignored: 0 }
  }
  if (["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"].indexOf(event) < 0)
    return { ok: true, stored: 0, ignored: 1 }
  if (!SNOWFLAKE.test(data.channel_id || "")) throw new Error("invalid channel id")
  const ids = event === "MESSAGE_DELETE_BULK" ? data.ids : [data.id]
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !SNOWFLAKE.test(id)))
    throw new Error("invalid message ids")
  const policy = selected(app, data.channel_id, helper)
  if (!policy.on) return { ok: true, stored: 0, ignored: ids.length, reason: policy.reason || "not_selected" }
  const rows = app.findRecordsByFilter("discord_entities", "entity_id = {:id}", "", 1, 0, { id: data.channel_id })
  if (!rows.length) return { ok: true, stored: 0, ignored: ids.length, reason: "unknown_channel" }
  const channel = JSON.parse(JSON.stringify(rows[0].publicExport()))
  if (helper.IMPORTABLE_TYPES.indexOf(channel.discord_type) < 0) return { ok: true, stored: 0, ignored: ids.length, reason: "not_importable" }
  const thread = channel.kind === "thread"
  const context = { channel_id: thread ? channel.parent_id : channel.entity_id,
    thread_id: thread ? channel.entity_id : null, guild_id: channel.guild_id }
  let stored = 0
  for (const id of ids) {
    const message = Object.assign({}, data, { id })
    delete message.ids
    if (ingest.upsertDispatch(app, message, context, event === "MESSAGE_DELETE_BULK" ? "MESSAGE_DELETE" : event)) stored++
  }
  return { ok: true, stored, ignored: ids.length - stored }
}

function status(value, now) {
  const timestamp = typeof value.updated_at === "number" ? value.updated_at : 0
  const fresh = now - timestamp >= 0 && now - timestamp < 20
  const last = typeof value.last_event_at === "number" ? value.last_event_at : null
  const connected = fresh && value.connected === true
  const since = typeof value.connected_since === "number" && value.connected_since > 0 && value.connected_since <= now
    ? new Date(value.connected_since * 1000).toISOString() : null
  return { connected, connected_since: connected ? since : null, enabled: value.enabled !== false,
    session_id: typeof value.session_id === "string" ? value.session_id : null,
    last_event_age: last === null ? null : Math.max(0, now - last),
    events_per_minute: (value.event_times || []).filter((t) => typeof t === "number" && t > now - 60 && t <= now).length,
    received: value.received || 0, stored: value.stored || 0, ignored: value.ignored || 0,
    error: !fresh ? "listener_not_running" : value.error || null }
}
module.exports = Object.freeze({ dispatch, selected, saveEntity, status })
