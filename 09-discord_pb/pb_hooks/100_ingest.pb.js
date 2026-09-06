/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/discord/internal/upsert", (e) => {
  const want = $os.getenv("DISCORD_PB_INTERNAL_TOKEN") || ""
  if (!want || (e.request.header.get("X-Discord-PB-Token") || "") !== want) {
    return e.json(401, { ok: false, error: "unauthorized" })
  }
  const body = e.requestInfo().body || {}
  const messages = Array.isArray(body.messages) ? body.messages : null
  if (!messages) return e.json(400, { ok: false, error: "expected {messages: [...]}" })
  const collection = $app.findCollectionByNameOrId("discord_messages")
  let inserted = 0, updated = 0
  for (const item of messages) {
    if (!item || !item.message_id) continue
    let record
    try {
      record = $app.findFirstRecordByFilter("discord_messages", "message_id = {:id}", { id: item.message_id })
      record.load(item)
      updated++
    } catch (_) {
      record = new Record(collection, item)
      inserted++
    }
    $app.save(record)
  }
  return e.json(200, { ok: true, inserted, updated, received: messages.length })
})
