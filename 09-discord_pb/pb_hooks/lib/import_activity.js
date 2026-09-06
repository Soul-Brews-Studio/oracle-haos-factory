// Explicit ingestion metadata. Never a substitute for discord_messages.ts.
function markImports(app, targets) {
  const at = new Date().toISOString()
  const collection = app.findCollectionByNameOrId("dc_settings")
  for (const id of Object.keys(targets)) {
    const key = "import:" + id
    const found = app.findRecordsByFilter("dc_settings", "key = {:key}", "", 1, 0, { key })
    const record = found.length ? found[0] : new Record(collection)
    record.set("key", key); record.set("value", { at }); app.save(record)
  }
}
module.exports = Object.freeze({ markImports })
