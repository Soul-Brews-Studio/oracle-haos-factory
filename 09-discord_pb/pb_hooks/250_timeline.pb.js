/// <reference path="../pb_data/types.d.ts" />
// Central timeline: one chronological list of what happened across every
// server — messages (with edit/delete badges), thread creations/archivals,
// last-import markers — plus the system strip (gateway live status, last
// backfill run). Every handler requires its helpers itself: handlers run in
// isolated runtimes.
//
// Contract: since/before = time window for every kind; cursor = keyset cursor
// (ts|message_id) for the next page of messages. Threads and imports are
// clipped to the same slice of time as the page's messages, so pages stay
// chronological when the client appends them.

routerAdd("GET", "/api/dc/timeline", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const helper = require(`${__hooks}/lib/dc_api.js`), events = require(`${__hooks}/lib/dc_events.js`)
  try {
    const input = events.validateQuery(e.requestInfo().query)
    const params = {}
    const where = ["1=1"]
    if (input.since) { where.push("m.ts >= {:since}"); params.since = events.pbDate(input.since) }
    if (input.before) { where.push("m.ts < {:before}"); params.before = events.pbDate(input.before) }
    if (input.cursor) {
      where.push("(m.ts < {:cts} OR (m.ts = {:cts} AND m.message_id < {:cid}))")
      params.cts = events.pbDate(input.cursor.ts); params.cid = input.cursor.id
    }
    if (input.guilds.length) {
      where.push("m.guild_id IN (" + input.guilds.map((_, i) => `{:g${i}}`).join(",") + ")")
      input.guilds.forEach((id, i) => { params[`g${i}`] = id })
    }
    if (input.q) { where.push("(m.content LIKE {:q} ESCAPE '\\' OR m.author_name LIKE {:q} ESCAPE '\\')"); params.q = events.likePattern(input.q) }
    params.limit = input.limit

    let messages = []
    if (input.kinds.indexOf("message") >= 0) {
      const rows = arrayOf(new DynamicModel({ message_id: "", ts: "", edited: "", channel_id: "", thread_id: "", guild_id: "", author_id: "",
        author_name: "", author_is_bot: false, content: "", deleted: 0, attachments: 0, reply_to: "", channel: "", thread: "", guild: "", category: "" }))
      $app.db().newQuery("SELECT m.message_id, m.ts, COALESCE(m.edited_timestamp,'') edited, m.channel_id, COALESCE(m.thread_id,'') thread_id, COALESCE(m.guild_id,'') guild_id, " +
        "m.author_id, COALESCE(m.author_name,'') author_name, m.author_is_bot, COALESCE(m.content,'') content, " +
        "COALESCE(json_extract(m.raw,'$._discord_pb_deleted'),0) deleted, " +
        "CASE WHEN json_valid(m.attachments_json) AND json_type(m.attachments_json)='array' THEN json_array_length(m.attachments_json) ELSE 0 END attachments, " +
        "COALESCE(m.reply_to,'') reply_to, COALESCE(c.name,'') channel, COALESCE(t.name,'') thread, COALESCE(g.name,'') guild, COALESCE(cat.name,'') category " +
        "FROM discord_messages m " +
        "LEFT JOIN discord_entities c ON c.entity_id=m.channel_id " +
        "LEFT JOIN discord_entities t ON t.entity_id=m.thread_id " +
        "LEFT JOIN discord_entities g ON g.entity_id=m.guild_id " +
        "LEFT JOIN discord_entities cat ON cat.entity_id=json_extract(c.raw,'$.parent_id') " +
        "WHERE " + where.join(" AND ") + " ORDER BY m.ts DESC, m.message_id DESC LIMIT {:limit}").bind(params).all(rows)
      messages = rows.map(events.messageEvent)
    }
    const hasMore = messages.length === input.limit
    const oldestMessage = messages.length ? messages[messages.length - 1] : null

    // The slice of time this page covers. Upper bound: the cursor's instant (or
    // the window's `before`); lower bound: the oldest message on the page when
    // another page follows, otherwise the window's `since`. Threads and imports
    // inside that slice ride along with this page; nothing outside it does.
    const sliceUpper = input.cursor ? input.cursor.ts : input.before
    const sliceLower = hasMore && oldestMessage ? oldestMessage.ts : input.since
    const inSlice = (ev) => ev && events.inWindow(ev.ts, sliceLower, sliceUpper) && (!input.guilds.length || input.guilds.indexOf(ev.guild_id) >= 0)

    // Threads and imports are few (hundreds at most); their timestamps are ISO
    // text from Discord, not PocketBase date columns, so they are read whole and
    // filtered in JS. Only when messages are off do they page in one go.
    let threads = [], imports = []
    if (input.kinds.indexOf("thread") >= 0) {
      const rows = arrayOf(new DynamicModel({ entity_id: "", name: "", parent_id: "", guild_id: "", created: "", archived_at: "", owner_id: "", archived: false, channel: "", guild: "" }))
      $app.db().newQuery("SELECT e.entity_id, e.name, COALESCE(e.parent_id,'') parent_id, COALESCE(e.guild_id,'') guild_id, " +
        "COALESCE(json_extract(e.raw,'$.thread_metadata.create_timestamp'),'') created, COALESCE(json_extract(e.raw,'$.thread_metadata.archive_timestamp'),'') archived_at, " +
        "COALESCE(json_extract(e.raw,'$.owner_id'),'') owner_id, e.archived, " +
        "COALESCE(p.name,'') channel, COALESCE(g.name,'') guild FROM discord_entities e " +
        "LEFT JOIN discord_entities p ON p.entity_id=e.parent_id LEFT JOIN discord_entities g ON g.entity_id=e.guild_id WHERE e.kind='thread'").all(rows)
      for (const row of rows) for (const ev of events.threadEvents(row)) if (inSlice(ev)) threads.push(ev)
    }
    if (input.kinds.indexOf("import") >= 0) {
      const names = {}
      for (const row of helper.entityRows($app, false)) names[row.entity_id] = row
      const guildNames = {}
      for (const row of helper.entityRows($app, true)) guildNames[row.entity_id] = row.name
      for (let offset = 0; ; offset += 500) {
        const page = $app.findRecordsByFilter("dc_settings", "key ~ 'import:%'", "key", 500, offset)
        for (const record of page) {
          const id = record.getString("key").slice("import:".length)
          let value = {}
          try { value = JSON.parse(record.getString("value") || "{}") } catch (_) {}
          const entity = names[id]
          const meta = entity ? { kind: entity.kind, name: entity.name, guild_id: entity.guild_id, guild: guildNames[entity.guild_id] || entity.guild_id,
            parent_id: entity.parent_id, parent: names[entity.parent_id] ? names[entity.parent_id].name : null } : null
          const ev = events.importEvent(id, value.at, meta)
          if (inSlice(ev)) imports.push(ev)
        }
        if (page.length < 500) break
      }
    }

    const merged = events.mergeEvents([messages, threads, imports])
    let system = null
    if (!input.cursor) {
      let job = null, live = {}
      try { job = JSON.parse(toString($os.readFile("/data/backfill-job.json"))) } catch (_) {}
      try { live = JSON.parse(toString($os.readFile("/data/live-status.json"))) } catch (_) {}
      const status = require(`${__hooks}/lib/discord_live.js`).status(live, Date.now() / 1000)
      system = { backfill: job, live_status: status }
    }
    return e.json(200, { ok: true, events: merged, has_more: hasMore, next_cursor: hasMore ? events.cursorOf(oldestMessage) : null,
      slice: { since: sliceLower, before: sliceUpper },
      window: { since: input.since, before: input.before, limit: input.limit, kinds: input.kinds, guilds: input.guilds, q: input.q }, system })
  } catch (error) {
    if (!(error && Number.isInteger(error.status))) $app.logger().error("dc timeline failed", "error", String(error && error.stack || error))
    return helper.jsonError(e, error)
  }
}, $apis.requireSuperuserAuth())
