/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    name: "discord_messages",
    type: "base",
    system: false,
    fields: [
      { name: "message_id", type: "text", required: true, max: 20 },
      { name: "channel_id", type: "text", required: true, max: 20 },
      { name: "thread_id", type: "text", required: false, max: 20 },
      { name: "guild_id", type: "text", required: false, max: 20 },
      { name: "author_id", type: "text", required: true, max: 20 },
      { name: "author_name", type: "text", required: false },
      { name: "author_is_bot", type: "bool", required: false },
      { name: "content", type: "text", required: false },
      { name: "attachments_json", type: "json", required: false },
      { name: "ts", type: "date", required: true },
      { name: "routed_to", type: "text", required: false },
      { name: "routed_at", type: "date", required: false },
      { name: "created_at", type: "date", required: true },
      { name: "edited_timestamp", type: "date", required: false },
      { name: "embeds", type: "json", required: false },
      { name: "reply_to", type: "text", required: false, max: 20 },
      { name: "raw", type: "json", required: false }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_dm_message_id ON discord_messages (message_id)",
      "CREATE INDEX idx_dm_channel_ts ON discord_messages (channel_id, ts)",
      "CREATE INDEX idx_dm_thread ON discord_messages (thread_id)",
      "CREATE INDEX idx_dm_author ON discord_messages (author_id)"
    ],
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    options: {}
  })
  return app.save(collection)
}, (app) => app.delete(app.findCollectionByNameOrId("discord_messages")))
