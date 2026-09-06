/// <reference path="../pb_data/types.d.ts" />
// Repair existing aliases without changing the message collection. Discord's
// category parent remains preserved in raw; channel aliases point to guilds.
migrate((app) => {
  app.db().newQuery("UPDATE discord_entities SET parent_id = guild_id WHERE kind = 'channel'").execute()
  app.db().newQuery("UPDATE discord_entities SET parent_id = '' WHERE kind = 'guild'").execute()
}, () => {
  // Data correction is intentionally retained on rollback; raw preserves source metadata.
})
