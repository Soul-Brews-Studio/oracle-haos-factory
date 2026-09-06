/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    name: "discord_entities", type: "base", system: false,
    fields: [
      { name: "entity_id", type: "text", required: true, max: 20 },
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["guild", "channel", "thread"] },
      { name: "name", type: "text", required: true },
      { name: "parent_id", type: "text", required: false, max: 20 },
      { name: "guild_id", type: "text", required: false, max: 20 },
      { name: "discord_type", type: "number", required: false },
      { name: "archived", type: "bool", required: false },
      { name: "raw", type: "json", required: false },
      { name: "seen_at", type: "date", required: true }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_de_entity_id ON discord_entities (entity_id)",
      "CREATE INDEX idx_de_name_ci ON discord_entities (LOWER(name))",
      "CREATE INDEX idx_de_parent ON discord_entities (parent_id)",
      "CREATE INDEX idx_de_guild ON discord_entities (guild_id)"
    ],
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, options: {}
  })
  return app.save(collection)
}, (app) => app.delete(app.findCollectionByNameOrId("discord_entities")))
