/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/discord/internal/upsert", (e) => {
  const want = $os.getenv("DISCORD_PB_INTERNAL_TOKEN") || ""
  const peer = e.remoteIP()
  if (peer !== "127.0.0.1" || !want || e.request.header.get("X-Discord-PB-Token") !== want) {
    return e.json(401, { ok: false, error: "unauthorized" })
  }
  const messages = e.requestInfo().body.messages
  if (!Array.isArray(messages) || messages.length > 100) {
    return e.json(400, { ok: false, error: "expected at most 100 messages" })
  }
  const fields = ["message_id", "channel_id", "thread_id", "guild_id", "author_id", "author_name",
    "author_is_bot", "content", "attachments_json", "ts", "edited_timestamp", "embeds", "reply_to", "raw"]
  const snowflake = /^\d{17,20}$/
  for (const item of messages) {
    if (!item || !snowflake.test(item.message_id) || !snowflake.test(item.channel_id) ||
        !snowflake.test(item.author_id) || !item.ts || Object.keys(item).some(k => fields.indexOf(k) < 0)) {
      return e.json(400, { ok: false, error: "invalid message fields" })
    }
  }
  let inserted = 0, updated = 0
  // A page commits atomically. Retried pages are safe after disconnects or restarts.
  $app.runInTransaction((app) => {
    const collection = app.findCollectionByNameOrId("discord_messages")
    for (const item of messages) {
      const found = app.findRecordsByFilter("discord_messages", "message_id = {:id}", "", 1, 0, { id: item.message_id })
      const record = found.length ? found[0] : new Record(collection)
      if (!found.length) record.set("created_at", new Date().toISOString())
      for (const name of fields) if (Object.prototype.hasOwnProperty.call(item, name)) record.set(name, item[name])
      app.save(record)
      if (found.length) updated++; else inserted++
    }
  })
  return e.json(200, { ok: true, inserted, updated, received: messages.length })
})
