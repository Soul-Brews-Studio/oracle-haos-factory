/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/discord/internal/upsert", (e) => {
  const want = $os.getenv("DISCORD_PB_INTERNAL_TOKEN") || ""
  const peer = e.remoteIP()
  if (peer !== "127.0.0.1" || !want || e.request.header.get("X-Discord-PB-Token") !== want) {
    return e.json(401, { ok: false, error: "unauthorized" })
  }

  const ingest = require(`${__hooks}/lib/discord_ingest.js`)
  const body = e.requestInfo().body
  const error = ingest.validateEnvelope(body)
  if (error) return e.json(400, { ok: false, error })

  const result = ingest.upsertMessages($app, body.messages, require(__hooks + "/lib/import_activity.js").markImports)
  return e.json(200, { ok: true, inserted: result.inserted, updated: result.updated, received: body.messages.length })
})

routerAdd("POST", "/api/discord/import", (e) => {
  const ingest = require(`${__hooks}/lib/discord_ingest.js`)
  const body = e.requestInfo().body
  const error = ingest.validateEnvelope(body)
  if (error) return e.json(400, { ok: false, error })

  const result = ingest.upsertMessages($app, body.messages, require(__hooks + "/lib/import_activity.js").markImports)
  return e.json(200, { ok: true, inserted: result.inserted, updated: result.updated, received: body.messages.length })
}, $apis.requireSuperuserAuth())
