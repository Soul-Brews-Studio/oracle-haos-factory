routerAdd("POST", "/api/discord/internal/import-complete", (e) => {
  if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN"))
    return e.json(401, { ok: false, error: "unauthorized" })
  const id = e.requestInfo().body.entity_id
  if (typeof id !== "string" || !/^\d{17,20}$/.test(id)) return e.json(400, { ok:false, error:"invalid channel id" })
  const targets = {}; targets[id] = true
  $app.runInTransaction((app) => require(__hooks + "/lib/import_activity.js").markImports(app, targets))
  return e.json(200, { ok:true })
})
