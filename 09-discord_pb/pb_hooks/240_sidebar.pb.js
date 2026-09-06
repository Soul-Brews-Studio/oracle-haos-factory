/// <reference path="../pb_data/types.d.ts" />
// Server-by-server sidebar: one call returns every guild with counts, every
// channel/thread with its Discord category and position, and the shared
// open/hidden preferences. Preferences persist in dc_settings (key "sidebar").

function sidebarPrefs(app) {
  const rows = app.findRecordsByFilter("dc_settings", "key = 'sidebar'", "", 1)
  if (!rows.length) return null
  try { return JSON.parse(JSON.stringify(rows[0].get("value"))) } catch (_) { return null }
}

routerAdd("GET", "/api/dc/sidebar", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`), sidebar = require(`${__hooks}/lib/dc_sidebar.js`)
  try {
    const prefs = sidebar.normalizePrefs(sidebarPrefs($app))
    const guildRows = helper.entityRows($app, true)
    const guildNames = {}
    for (const row of guildRows) guildNames[row.entity_id] = row.name

    // Category (Discord type 4) and position stay in raw; the alias hierarchy in
    // parent_id is thread -> channel -> guild (migration 003). Counts join the
    // same way /api/dc/channels does so both surfaces agree.
    const rows = arrayOf(new DynamicModel({ entity_id: "", kind: "", name: "", parent_id: "", guild_id: "", discord_type: 0,
      archived: false, category_id: "", position: 0, count: 0, last_message_at: "" }))
    $app.db().newQuery("SELECT e.entity_id, e.kind, e.name, COALESCE(e.parent_id,'') parent_id, COALESCE(e.guild_id,'') guild_id, e.discord_type, e.archived, " +
      "CASE WHEN e.kind='channel' THEN COALESCE(json_extract(e.raw,'$.parent_id'),'') ELSE '' END category_id, " +
      "COALESCE(json_extract(e.raw,'$.position'),0) position, COUNT(m.id) count, COALESCE(MAX(m.ts),'') last_message_at " +
      "FROM discord_entities e LEFT JOIN discord_messages m ON (e.kind='thread' AND m.thread_id=e.entity_id) OR (e.kind='channel' AND m.channel_id=e.entity_id AND COALESCE(m.thread_id,'')='') " +
      "WHERE e.kind!='guild' GROUP BY e.entity_id").all(rows)

    const totalsRows = arrayOf(new DynamicModel({ guild_id: "", count: 0, last: "" }))
    $app.db().newQuery("SELECT COALESCE(guild_id,'') guild_id, COUNT(*) count, COALESCE(MAX(ts),'') last FROM discord_messages GROUP BY guild_id").all(totalsRows)
    const iso = (value) => value ? new Date(String(value).replace(" ", "T")).toISOString() : null
    const totals = {}
    for (const row of totalsRows) if (row.guild_id) totals[row.guild_id] = { count: row.count, last: iso(row.last) }

    // Selection follows the declared model when it exists (cached compile), and
    // the checkbox table otherwise. A broken model is reported, not hidden.
    let selected = {}, modelError = null
    const model = helper.liveModel($app)
    if (model.ok && model.exists && model.channels) for (const id of Object.keys(model.channels)) if (model.channels[id].import) selected[id] = true
    else if (model.ok) selected = helper.selectedMap($app)
    else { modelError = model.error || "validation failed"; selected = helper.selectedMap($app) }

    const channels = rows.map((row) => ({
      id: row.entity_id, kind: row.kind, name: row.name, guild_id: row.guild_id, guild: guildNames[row.guild_id] || row.guild_id,
      parent: row.parent_id || null, category_id: row.category_id ? String(row.category_id) : null, position: Number(row.position) || 0,
      discord_type: row.discord_type, archived: !!row.archived, importable: helper.IMPORTABLE_TYPES.indexOf(row.discord_type) >= 0,
      imported_count: row.count, last_message_at: iso(row.last_message_at), selected: !!selected[row.entity_id],
    }))
    const guilds = sidebar.guildSummary(guildRows, channels, totals, prefs)
    return e.json(200, { ok: true, guilds, channels, prefs, model_error: modelError })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("POST", "/api/dc/sidebar", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`), sidebar = require(`${__hooks}/lib/dc_sidebar.js`)
  try {
    let merged
    try { merged = sidebar.mergePrefs(sidebarPrefs($app), e.requestInfo().body) }
    catch (error) { throw helper.apiError(400, String(error.message || error)) }
    // Only ids the archive knows about can be hidden or reordered; a stale id
    // from another browser is dropped rather than stored forever.
    const known = {}
    for (const row of helper.entityRows($app, true)) known[row.entity_id] = true
    merged.hidden = merged.hidden.filter((id) => known[id])
    merged.order = merged.order.filter((id) => known[id])
    $app.runInTransaction((app) => {
      const found = app.findRecordsByFilter("dc_settings", "key = 'sidebar'", "", 1)
      const record = found.length ? found[0] : new Record(app.findCollectionByNameOrId("dc_settings"))
      record.set("key", "sidebar"); record.set("value", merged); app.save(record)
    })
    return e.json(200, { ok: true, prefs: merged })
  } catch (error) { return helper.jsonError(e, error) }
}, $apis.requireSuperuserAuth())
