/// <reference path="../pb_data/types.d.ts" />
routerAdd("GET", "/api/discord/status", (e) => {
  const rows = arrayOf(new DynamicModel({ channel_id: "", count: 0 }))
  $app.db().newQuery("SELECT channel_id, COUNT(*) AS count FROM discord_messages GROUP BY channel_id ORDER BY channel_id").all(rows)
  return e.json(200, { ok: true, total: $app.countRecords("discord_messages"), channels: rows })
})
