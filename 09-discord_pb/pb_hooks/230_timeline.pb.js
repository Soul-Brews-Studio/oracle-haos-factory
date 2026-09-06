/// <reference path="../pb_data/types.d.ts" />
// Sparse message-create-time histograms. Imported/record creation time is deliberately absent.

routerAdd("GET", "/api/dc/channels/{channel}/timeline", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const api = require(`${__hooks}/lib/dc_api.js`), timeline = require(`${__hooks}/lib/dc_timeline.js`)
  try {
    const target = api.resolveEntity(api.entityRows($app, false), e.request.pathValue("channel"), api.CHANNEL_KINDS)
    const bucket = timeline.validateBucket(e.requestInfo().query.bucket)
    const format = bucket === "hour" ? "%Y-%m-%dT%H:00:00" : "%Y-%m-%d"
    const predicate = target.kind === "thread" ? "thread_id = {:id}" : "channel_id = {:id} AND COALESCE(thread_id,'') = ''"
    const rows = arrayOf(new DynamicModel({ bucket: "", first: "", last: "", count: 0 }))
    $app.db().newQuery(`SELECT strftime('${format}', datetime(ts,'+7 hours')) bucket, MIN(ts) first, MAX(ts) last, COUNT(*) count FROM discord_messages WHERE ${predicate} GROUP BY bucket ORDER BY bucket`).bind({id: target.entity_id}).all(rows)
    return e.json(200, timeline.presentTimeline(rows, bucket, {id: target.entity_id, name: target.name, kind: target.kind}))
  } catch (error) { return api.jsonError(e, error) }
}, $apis.requireSuperuserAuth())

routerAdd("GET", "/api/dc/guilds/{guild}/timeline", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  const api = require(`${__hooks}/lib/dc_api.js`), timeline = require(`${__hooks}/lib/dc_timeline.js`)
  try {
    const target = api.resolveEntity(api.entityRows($app, true), e.request.pathValue("guild"), ["guild"])
    const bucket = timeline.validateBucket(e.requestInfo().query.bucket)
    const format = bucket === "hour" ? "%Y-%m-%dT%H:00:00" : "%Y-%m-%d"
    const rows = arrayOf(new DynamicModel({ bucket: "", first: "", last: "", count: 0 }))
    $app.db().newQuery(`SELECT strftime('${format}', datetime(ts,'+7 hours')) bucket, MIN(ts) first, MAX(ts) last, COUNT(*) count FROM discord_messages WHERE guild_id = {:id} GROUP BY bucket ORDER BY bucket`).bind({id: target.entity_id}).all(rows)
    return e.json(200, timeline.presentTimeline(rows, bucket, {id: target.entity_id, name: target.name, kind: target.kind}))
  } catch (error) { return api.jsonError(e, error) }
}, $apis.requireSuperuserAuth())
