routerAdd("POST", "/api/discord/internal/selection", (e) => {
  if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN"))
    return e.json(401, { error: "unauthorized" })
  const initial = e.requestInfo().body.initial
  if (initial !== undefined && (!Array.isArray(initial) || initial.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))))
    return e.json(400, { error: "initial selection must contain channel IDs" })
  let initialized = false
  $app.runInTransaction((app) => {
    initialized = app.findRecordsByFilter("dc_settings", "key = 'selection_initialized'", "", 1).length > 0
    if (initialized || initial === undefined) return
    const helper = require(__hooks + "/lib/dc_api.js")
    for (const id of initial) {
      const rows = app.findRecordsByFilter("discord_entities", "entity_id = {:id} && kind != 'guild'", "", 1, 0, { id })
      if (!rows.length) throw new BadRequestError("Initial channel must be discovered before selection: " + id)
      if (helper.IMPORTABLE_TYPES.indexOf(rows[0].getInt("discord_type")) < 0)
        throw new BadRequestError("Initial channel is not importable: " + id)
    }
    for (const id of initial) {
      // Never undo a checkbox selection made before the first scheduled poll.
      if (app.findRecordsByFilter("dc_channel_selection", "entity_id = {:id}", "", 1, 0, { id }).length) continue
      const r = new Record(app.findCollectionByNameOrId("dc_channel_selection"))
      r.set("entity_id", id); r.set("on", true); app.save(r)
    }
    const marker = new Record(app.findCollectionByNameOrId("dc_settings"))
    marker.set("key", "selection_initialized"); marker.set("value", true); app.save(marker)
    initialized = true
  })
  const selected = [], requests = []
  for (let offset = 0; ; offset += 500) {
    const rows = $app.findRecordsByFilter("dc_channel_selection", "on = true", "entity_id", 500, offset)
    for (const r of rows) selected.push(r.getString("entity_id"))
    if (rows.length < 500) break
  }
  for (let offset = 0; ; offset += 500) {
    const rows = $app.findRecordsByFilter("dc_import_requests", "", "entity_id", 500, offset)
    for (const r of rows) requests.push({ entity_id: r.getString("entity_id"), request_id: r.getString("request_id") })
    if (rows.length < 500) break
  }
  let model = { exists: false }
  if (e.requestInfo().body.metadata_only !== true) {
    model = require(__hooks + "/lib/dc_api.js").getModel($app)
    if (!model.ok) return e.json(400, { error: model.error || "Invalid dc.config.yaml" })
  }
  return e.json(200, { initialized, model_present: model.exists,
    selected: model.exists ? Object.keys(model.channels).filter((id) => model.channels[id].import) : selected, requests })
})

routerAdd("POST", "/api/discord/internal/import-ack", (e) => {
  if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN"))
    return e.json(401, { error: "unauthorized" })
  const body = e.requestInfo().body
  $app.runInTransaction((app) => {
    const rows = app.findRecordsByFilter("dc_import_requests", "entity_id = {:id} && request_id = {:request}", "", 1, 0,
      { id: String(body.entity_id || ""), request: String(body.request_id || "") })
    if (rows.length) app.delete(rows[0])
  })
  return e.json(200, { ok: true })
})
