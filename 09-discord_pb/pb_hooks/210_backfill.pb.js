/// <reference path="../pb_data/types.d.ts" />
// Control only the configured worker. Never accept a shell command or credentials.
routerAdd("GET", "/api/discord/backfill", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  let state = { state: "starting" }
  try { state = JSON.parse(toString($os.readFile("/data/backfill-job.json"))) } catch (_) {}
  let queued = false
  try { $os.stat("/data/backfill-request"); queued = true } catch (_) {}
  return e.json(200, {
    ok: true, configured: $os.getenv("DISCORD_PB_BACKFILL_READY") === "true",
    state: state.state, finished_at: state.finished_at || null,
    started_at: state.started_at || null, queued
  })
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/discord/backfill", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  if ($os.getenv("DISCORD_PB_BACKFILL_READY") !== "true") {
    return e.json(409, { ok: false, error: "Set bot_token and channels or guilds in the add-on options, then restart. JSON import does not need a Discord bot token." })
  }
  // One coalescing marker, consumed only after the current worker finishes.
  $os.writeFile("/data/backfill-request", "1", 0o600)
  return e.json(202, { ok: true, state: "queued" })
}, $apis.requireSuperuserAuth())
