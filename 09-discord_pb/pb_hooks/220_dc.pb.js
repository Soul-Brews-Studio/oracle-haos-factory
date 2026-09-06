/// <reference path="../pb_data/types.d.ts" />
// Authenticated channel handles. Every handler requires its immutable helper;
// PocketBase executes handlers in isolated JSVM runtimes.

routerAdd("GET", "/api/dc/channels", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), guilds = helper.entityRows($app, true), all = rows.concat(guilds)
    const guildQuery = String(e.requestInfo().query.guild || "").trim()
    const guild = guildQuery ? helper.resolveEntity(all, guildQuery, ["guild"]) : null
    const model = helper.getModel($app)
    if (!model.ok) throw helper.apiError(400, `declared channel model is invalid: ${model.error || "validation failed"}`)
    const selected = helper.selectedMap($app), guildNames = {}
    for (const row of guilds) guildNames[row.entity_id] = row.name
    const visible = guild ? rows.filter((row) => row.guild_id === guild.entity_id) : rows
    const counts = arrayOf(new DynamicModel({ entity_id: "", count: 0 }))
    $app.db().newQuery("SELECT e.entity_id, COUNT(m.id) count FROM discord_entities e LEFT JOIN discord_messages m ON (e.kind='thread' AND m.thread_id=e.entity_id) OR (e.kind='channel' AND m.channel_id=e.entity_id AND COALESCE(m.thread_id,'')='') WHERE e.kind!='guild' GROUP BY e.entity_id").all(counts)
    const countById = {}; for (const row of counts) countById[row.entity_id] = row.count
    return e.json(200, visible.map((row) => {
      const policy = model.exists && model.channels ? model.channels[row.entity_id] : null
      return { id: row.entity_id, name: row.name, guild: guildNames[row.guild_id] || row.guild_id, guild_id: row.guild_id, kind: row.kind,
        parent: row.parent_id || null, archived: row.archived, imported_count: countById[row.entity_id] || 0,
        discord_type: row.discord_type, importable: helper.IMPORTABLE_TYPES.indexOf(row.discord_type) >= 0,
        selected: model.exists ? !!(policy && policy.import) : !!selected[row.entity_id], purpose: policy ? policy.purpose : null,
        owner: policy ? policy.owner : null, post: policy ? !!policy.post : false, actions: policy ? policy.actions || [] : [] }
    }))
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("GET", "/api/dc/channels/{channel}/read", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const channel = helper.resolveEntity(helper.entityRows($app, false), e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const query = e.requestInfo().query, input = helper.validateRead({ limit: query.limit, since: query.since, before: query.before })
    let filter = channel.kind === "thread" ? "thread_id = {:id}" : "channel_id = {:id} && thread_id = ''"
    const params = { id: channel.entity_id }
    if (input.since) { filter += " && ts >= {:since}"; params.since = input.since }
    if (input.before) { filter += " && ts < {:before}"; params.before = input.before }
    const records = $app.findRecordsByFilter("discord_messages", filter, "-ts,-message_id", input.limit, 0, params)
    return e.json(200, { ok: true, channel: { id: channel.entity_id, name: channel.name, kind: channel.kind }, messages: records.map(helper.message) })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/select", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const channel = helper.resolveEntity(helper.entityRows($app, false), e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const input = helper.validateWrite("select", e.requestInfo().body)
    if (input.on) helper.assertImportable(channel)
    const current = Object.keys(helper.selectedMap($app)).filter((id) => id !== channel.entity_id)
    if (input.on) current.push(channel.entity_id)
    const model = helper.runModel($app, "set", { entity_id: channel.entity_id, changes: { import: input.on }, selected: current })
    if (!model.ok) throw helper.apiError(400, String(model.error || "declared channel model update failed"))
    $app.runInTransaction((app) => {
      const found = app.findRecordsByFilter("dc_channel_selection", "entity_id = {:id}", "", 1, 0, { id: channel.entity_id })
      const record = found.length ? found[0] : new Record(app.findCollectionByNameOrId("dc_channel_selection"))
      record.set("entity_id", channel.entity_id); record.set("on", input.on); app.save(record)
    })
    $os.writeFile("/data/backfill-request", "1", 0o600)
    return e.json(200, { ok: true, id: channel.entity_id, selected: input.on })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/import", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const channel = helper.resolveEntity(helper.entityRows($app, false), e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    helper.assertImportable(channel)
    const requestId = $security.randomString(24)
    $app.runInTransaction((app) => {
      const found = app.findRecordsByFilter("dc_import_requests", "entity_id = {:id}", "", 1, 0, { id: channel.entity_id })
      const record = found.length ? found[0] : new Record(app.findCollectionByNameOrId("dc_import_requests"))
      record.set("entity_id", channel.entity_id); record.set("request_id", requestId); app.save(record)
    })
    // The database row is authoritative; this marker only wakes the scheduler.
    $os.writeFile("/data/dc-import-request", "1", 0o600)
    return e.json(202, { ok: true, id: channel.entity_id, request_id: requestId, state: "queued" })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/post", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), channel = helper.resolveEntity(rows, e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const input = helper.validateWrite("post", e.requestInfo().body); helper.assertWritePolicy(rows, channel, "post", helper.getModel($app), helper.options())
    const message = helper.discord("POST", `/channels/${channel.entity_id}/messages`, { content: input.text, allowed_mentions: { parse: [] } })
    return e.json(201, { ok: true, id: String(message.id || ""), channel_id: channel.entity_id })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/thread", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), channel = helper.resolveEntity(rows, e.request.pathValue("channel"), ["channel"])
    const input = helper.validateWrite("thread", e.requestInfo().body); helper.assertWritePolicy(rows, channel, "thread", helper.getModel($app), helper.options())
    let thread
    if ([15, 16].indexOf(channel.discord_type) >= 0) {
      thread = helper.discord("POST", `/channels/${channel.entity_id}/threads`, { name: input.name, auto_archive_duration: 1440, message: { content: input.starter, allowed_mentions: { parse: [] } } })
    } else if ([0, 5].indexOf(channel.discord_type) >= 0) {
      const starter = helper.discord("POST", `/channels/${channel.entity_id}/messages`, { content: input.starter, allowed_mentions: { parse: [] } })
      if (!helper.SNOWFLAKE.test(String(starter.id || ""))) throw helper.apiError(502, "Discord did not return a starter message id")
      thread = helper.discord("POST", `/channels/${channel.entity_id}/messages/${starter.id}/threads`, { name: input.name, auto_archive_duration: 1440 })
    } else throw helper.apiError(409, "threads can only be created in text, announcement, forum, or media channels")
    return e.json(201, { ok: true, id: String(thread.id || ""), name: String(thread.name || input.name), parent_id: channel.entity_id })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/pin", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), channel = helper.resolveEntity(rows, e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const input = helper.validateWrite("pin", e.requestInfo().body); helper.assertWritePolicy(rows, channel, "pin", helper.getModel($app), helper.options())
    const message = helper.discord("GET", `/channels/${channel.entity_id}/messages/${input.messageId}`)
    if (String(message.channel_id || "") !== channel.entity_id) throw helper.apiError(409, "message does not belong to this channel")
    helper.discord("PUT", `/channels/${channel.entity_id}/messages/pins/${input.messageId}`)
    return e.json(200, { ok: true, id: input.messageId, pinned: true })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/channels/{channel}/archive", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), channel = helper.resolveEntity(rows, e.request.pathValue("channel"), ["thread"])
    helper.validateWrite("archive", e.requestInfo().body); helper.assertWritePolicy(rows, channel, "archive", helper.getModel($app), helper.options())
    if (helper.THREAD_TYPES.indexOf(channel.discord_type) < 0) throw helper.apiError(409, "only Discord thread channels can be archived")
    const archived = helper.discord("PATCH", `/channels/${channel.entity_id}`, { archived: true })
    return e.json(200, { ok: true, id: String(archived.id || channel.entity_id), archived: true })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("GET", "/api/dc/channels/{channel}/allowed", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const rows = helper.entityRows($app, false), channel = helper.resolveEntity(rows, e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const verb = String(e.requestInfo().query.verb || "").trim()
    if (["post", "thread", "pin", "archive"].indexOf(verb) < 0) throw helper.apiError(400, "verb must be post, thread, pin, or archive")
    try {
      helper.assertWritePolicy(rows, channel, verb, helper.getModel($app), helper.options())
      return e.json(200, { ok: true, id: channel.entity_id, verb, allowed: true })
    } catch (denied) {
      if (denied.status !== 403) throw denied
      return e.json(200, { ok: true, id: channel.entity_id, verb, allowed: false, reason: denied.message })
    }
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("GET", "/api/dc/config", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const result = helper.getModel($app)
    return e.json(result.ok ? 200 : 400, result)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("GET", "/api/dc/config.yaml", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    let raw = ""
    try {
      raw = toString($os.readFile("/data/dc.config.yaml"))
      if (raw.length > 128 * 1024) throw helper.apiError(413, "dc.config.yaml exceeds 128 KiB")
    } catch (error) {
      if (error && error.status) throw error
      raw = "guilds: {}\noracles: {}\n"
    }
    e.response.header().set("Content-Type", "application/yaml; charset=utf-8")
    return e.string(200, raw)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/config/validate", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const body = e.requestInfo().body, values = {}
    if (Object.prototype.hasOwnProperty.call(body, "yaml")) values.yaml = body.yaml
    if (Object.prototype.hasOwnProperty.call(body, "config")) values.config = body.config
    const result = helper.runModel($app, "validate", values)
    return e.json(result.ok ? 200 : 400, result)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/config/save", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const body = e.requestInfo().body, values = {}
    if (Object.prototype.hasOwnProperty.call(body, "yaml")) values.yaml = body.yaml
    if (Object.prototype.hasOwnProperty.call(body, "config")) values.config = body.config
    const result = helper.runModel($app, "save", values)
    if (result.ok) $os.writeFile("/data/backfill-request", "1", 0o600)
    return e.json(result.ok ? 200 : 400, result)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/config/channel/{channel}", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const channel = helper.resolveEntity(helper.entityRows($app, false), e.request.pathValue("channel"), helper.CHANNEL_KINDS)
    const body = e.requestInfo().body
    const result = helper.runModel($app, "set", { entity_id: channel.entity_id, changes: body, selected: Object.keys(helper.selectedMap($app)) })
    if (result.ok) $os.writeFile("/data/backfill-request", "1", 0o600)
    return e.json(result.ok ? 200 : 400, result)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/config/reload", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`)
  try {
    const result = helper.runModel($app, "reload")
    if (result.ok) $os.writeFile("/data/backfill-request", "1", 0o600)
    return e.json(result.ok ? 200 : 400, result)
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())
