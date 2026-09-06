// Pure timeline validation and Bangkok-calendar presentation helpers.
// SQL performs the aggregation; this module makes the result deterministic and testable.

const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])
const DAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

function validateBucket(value) {
  const bucket = String(value || "day").trim()
  if (bucket !== "day" && bucket !== "hour") {
    const error = new Error("bucket must be day or hour")
    error.status = 400
    throw error
  }
  return bucket
}

function utcISO(value) {
  const parsed = Date.parse(String(value || "").replace(" ", "T"))
  if (!Number.isFinite(parsed)) throw new Error("timeline query returned an invalid timestamp")
  return new Date(parsed).toISOString()
}

function localParts(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):00:00)?$/.exec(String(key))
  if (!match) throw new Error("timeline query returned an invalid bucket")
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4] || 0)}
}

function dayKey(parts) {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`
}

function bucketStart(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour) - BANGKOK_OFFSET_MS).toISOString()
}

function label(parts, bucket) {
  const weekday = DAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()]
  const date = `${weekday} ${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`
  return bucket === "hour" ? `${date} ${parts.hour.toString().padStart(2, "0")}:00` : date
}

function gaps(rows) {
  if (rows.length < 2) return []
  const present = {}
  for (const row of rows) present[String(row.bucket).slice(0, 10)] = true
  const dates = Object.keys(present).sort()
  const result = []
  for (let index = 1; index < dates.length; index++) {
    const previous = Date.parse(dates[index - 1] + "T00:00:00Z")
    const current = Date.parse(dates[index] + "T00:00:00Z")
    const days = (current - previous) / 86400000 - 1
    if (days > 0) result.push({
      since: new Date(previous + 86400000).toISOString().slice(0, 10),
      before: dates[index], days,
    })
  }
  return result
}

function presentTimeline(rows, bucket, target) {
  bucket = validateBucket(bucket)
  const ordered = (rows || []).slice().sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
  let total = 0
  const buckets = ordered.map((row) => {
    const parts = localParts(row.bucket)
    const count = Number(row.count)
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("timeline query returned an invalid count")
    total += count
    return {start: bucketStart(parts), date: dayKey(parts), label: label(parts, bucket), count}
  })
  return {
    ok: true, bucket, time_zone: "Asia/Bangkok", target,
    first: ordered.length ? utcISO(ordered[0].first) : null,
    last: ordered.length ? utcISO(ordered[ordered.length - 1].last) : null,
    total, buckets, gaps: gaps(ordered),
  }
}

module.exports = Object.freeze({ validateBucket, presentTimeline })
