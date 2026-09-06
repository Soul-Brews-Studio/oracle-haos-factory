migrate((app) => {
  // Private operational state persists with PocketBase in /data/pb_data.
  for (const spec of [
    ["dc_channel_selection", "entity_id", [{ name: "on", type: "bool" }]],
    ["dc_import_requests", "entity_id", [{ name: "request_id", type: "text", required: true }]],
    ["dc_settings", "key", [{ name: "value", type: "json" }]],
  ]) {
    app.save(new Collection({ name: spec[0], type: "base",
      fields: [{ name: spec[1], type: "text", required: true }, ...spec[2]],
      indexes: ["CREATE UNIQUE INDEX idx_" + spec[0] + "_key ON " + spec[0] + " (" + spec[1] + ")"],
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    }))
  }
}, (app) => {
  for (const name of ["dc_settings", "dc_import_requests", "dc_channel_selection"])
    app.delete(app.findCollectionByNameOrId(name))
})
