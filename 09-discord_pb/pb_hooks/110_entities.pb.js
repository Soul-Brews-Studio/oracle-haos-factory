/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/discord/internal/entities", (e) => {
  try {
    if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN")) return e.json(401, { ok: false, error: "unauthorized" })
    const entities = e.requestInfo().body.entities
    if (!Array.isArray(entities) || entities.length > 500) return e.json(400, { ok: false, error: "invalid entities" })
    const collection = $app.findCollectionByNameOrId("discord_entities")
    let inserted = 0, updated = 0
    $app.runInTransaction((app) => {
    for (const item of entities) {
      if (!item || !/^\d{17,20}$/.test(item.entity_id) || ["guild", "channel", "thread"].indexOf(item.kind) < 0 || !item.name) {
        throw new BadRequestError("invalid entity")
      }
      const found = app.findRecordsByFilter("discord_entities", "entity_id = {:id}", "", 1, 0, { id: item.entity_id })
      const record = found.length ? found[0] : new Record(collection)
      for (const key of ["entity_id", "kind", "name", "parent_id", "guild_id", "discord_type", "archived", "raw", "seen_at"]) record.set(key, item[key])
      app.save(record); found.length ? updated++ : inserted++
    }
    })
    return e.json(200, { ok: true, received: entities.length, inserted, updated })
  } catch (err) { return e.json(400, { ok: false, error: String(err) }) }
})

routerAdd("POST", "/api/discord/internal/resolve", (e) => {
  if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN")) return e.json(401, { ok: false, error: "unauthorized" })
  const name = String(e.requestInfo().body.name || "").trim()
  const kind = String(e.requestInfo().body.kind || "").trim()
  const rows = $app.findRecordsByFilter("discord_entities", "name ~ {:name} && kind = {:kind}", "name,entity_id", 100, 0, { name, kind })
  return e.json(200, { ok: true, matches: rows.map((r) => ({ entity_id: r.getString("entity_id"), kind: r.getString("kind"), name: r.getString("name"), parent_id: r.getString("parent_id"), guild_id: r.getString("guild_id") })) })
})

routerAdd("GET", "/api/discord/entities/{name}", (e) => {
  const peer = e.remoteIP(), ingressPeer = $os.getenv("DISCORD_PB_INGRESS_PEER") || "172.30.32.2"
  if (peer !== ingressPeer || !e.request.header.get("X-Remote-User-Id")) return e.json(403, { ok: false, error: "Home Assistant ingress required" })
  const name = e.request.pathValue("name")
  const rows = $app.findRecordsByFilter("discord_entities", "name ~ {:name}", "kind,name,entity_id", 100, 0, { name })
  return e.json(200, { ok: true, matches: rows.map((r) => ({ entity_id: r.getString("entity_id"), kind: r.getString("kind"), name: r.getString("name"), parent_id: r.getString("parent_id"), guild_id: r.getString("guild_id") })) })
})
