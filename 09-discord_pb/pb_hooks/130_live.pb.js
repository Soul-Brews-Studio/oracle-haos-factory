routerAdd("POST", "/api/discord/internal/live", (e) => {
  if (e.remoteIP() !== "127.0.0.1" || !$os.getenv("DISCORD_PB_INTERNAL_TOKEN") || e.request.header.get("X-Discord-PB-Token") !== $os.getenv("DISCORD_PB_INTERNAL_TOKEN"))
    return e.json(401, { ok: false, error: "unauthorized" })
  try {
    const helper = require(__hooks + "/lib/dc_api.js")
    const ingest = require(__hooks + "/lib/discord_ingest.js")
    const live = require(__hooks + "/lib/discord_live.js")
    const body = e.requestInfo().body
    return e.json(200, live.dispatch($app, body.event, body.data, helper, ingest))
  } catch (_) {
    // Never reflect arbitrary upstream dispatch fields/credentials in errors.
    return e.json(400, { ok: false, error: "live dispatch could not be applied" })
  }
})

routerAdd("GET", "/api/dc/status", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  let value = {}
  try { value = JSON.parse(toString($os.readFile("/data/live-status.json"))) } catch (_) {}
  const live = require(__hooks + "/lib/discord_live.js")
  return e.json(200, { ok: true, live_status: live.status(value, Date.now() / 1000) })
}, $apis.requireSuperuserAuth())
