/// <reference path="../pb_data/types.d.ts" />
// The central timeline orders every message by (ts, message_id) and pages with
// a keyset cursor on the same tuple; the sidebar and timeline also count
// messages per guild. Without these indexes both are full scans + sorts once
// the archive holds hundreds of thousands of rows (measured 2026-09-07 on
// kvmlab1 while a 491-channel sweep was inserting: the sidebar API took >20 s).
migrate((app) => {
  const collection = app.findCollectionByNameOrId("discord_messages")
  const indexes = collection.indexes || []
  for (const sql of [
    "CREATE INDEX idx_dm_ts_id ON discord_messages (ts, message_id)",
    "CREATE INDEX idx_dm_guild_ts ON discord_messages (guild_id, ts)",
  ]) if (indexes.indexOf(sql) < 0) indexes.push(sql)
  collection.indexes = indexes
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("discord_messages")
  collection.indexes = (collection.indexes || []).filter((sql) => sql.indexOf("idx_dm_ts_id") < 0 && sql.indexOf("idx_dm_guild_ts") < 0)
  return app.save(collection)
})
