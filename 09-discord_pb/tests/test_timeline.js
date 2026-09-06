"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const timeline = require("../pb_hooks/lib/dc_timeline.js")

assert.equal(timeline.validateBucket(""), "day")
assert.equal(timeline.validateBucket("hour"), "hour")
assert.throws(() => timeline.validateBucket("week"), /day or hour/)

const target = {id: "1", name: "arra-01", kind: "channel"}
const day = timeline.presentTimeline([
  {bucket: "2024-02-29", first: "2024-02-28 17:00:00.000Z", last: "2024-02-28 17:59:59.000Z", count: 2},
  {bucket: "2024-03-02", first: "2024-03-01T18:00:00Z", last: "2024-03-01T18:00:00Z", count: 1},
  {bucket: "2025-01-01", first: "2024-12-31T17:00:00Z", last: "2024-12-31T17:00:00Z", count: 4},
], "day", target)
assert.equal(day.time_zone, "Asia/Bangkok")
assert.equal(day.total, 7)
assert.equal(day.first, "2024-02-28T17:00:00.000Z")
assert.equal(day.last, "2024-12-31T17:00:00.000Z")
assert.deepEqual(day.buckets[0], {start: "2024-02-28T17:00:00.000Z", date: "2024-02-29", label: "Thu 29 Feb 2024", count: 2})
assert.deepEqual(day.gaps[0], {since: "2024-03-01", before: "2024-03-02", days: 1})

const hour = timeline.presentTimeline([
  {bucket: "2026-01-01T00:00:00", first: "2025-12-31T17:00:00Z", last: "2025-12-31T17:10:00Z", count: 3},
  {bucket: "2026-01-01T01:00:00", first: "2025-12-31T18:00:00Z", last: "2025-12-31T18:00:00Z", count: 1},
], "hour", target)
assert.equal(hour.buckets[0].start, "2025-12-31T17:00:00.000Z")
assert.equal(hour.buckets[0].label, "Thu 1 Jan 2026 00:00")
assert.deepEqual(hour.gaps, [])

assert.deepEqual(timeline.presentTimeline([], "day", target), {
  ok: true, bucket: "day", time_zone: "Asia/Bangkok", target,
  first: null, last: null, total: 0, buckets: [], gaps: [],
})

const hook = fs.readFileSync(path.join(__dirname, "../pb_hooks/230_timeline.pb.js"), "utf8")
assert.equal((hook.match(/routerAdd\(/g) || []).length, (hook.match(/\$apis\.requireSuperuserAuth\(\)/g) || []).length)
assert(hook.includes("datetime(ts,'+7 hours')"), "calendar bucketing must use message ts in Bangkok")
assert(!hook.includes("created_at"), "timeline must never use import time")
console.log("timeline helper: 16 assertions passed")
