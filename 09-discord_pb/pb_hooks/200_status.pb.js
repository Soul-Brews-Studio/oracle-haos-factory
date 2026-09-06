/// <reference path="../pb_data/types.d.ts" />
routerAdd("GET", "/api/discord/status", (e) => {
  const rows = arrayOf(new DynamicModel({ channel_id: "", name: "", count: 0 }))
  $app.db().newQuery("SELECT m.channel_id, COALESCE(e.name, '') AS name, COUNT(*) AS count FROM discord_messages m LEFT JOIN discord_entities e ON e.entity_id=m.channel_id GROUP BY m.channel_id,e.name ORDER BY e.name,m.channel_id").all(rows)
  return e.json(200, { ok: true, total: $app.countRecords("discord_messages"), channels: rows })
})
