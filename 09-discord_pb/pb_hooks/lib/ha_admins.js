// Pure check for the auto-login hook: is this HA user an administrator according
// to the list ha_admins.py keeps fresh? Keep immutable (PocketBase caches modules).
// Fail closed: no file, unreadable JSON, stale timestamp, or unknown id all deny.

const MAX_AGE_MS = 15 * 60 * 1000

function parseAdmins(text) {
  let payload
  try { payload = JSON.parse(String(text || "")) } catch (_) { return null }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.admins)) return null
  const at = Date.parse(String(payload.at || ""))
  if (!Number.isFinite(at)) return null
  return { at, admins: payload.admins.filter((id) => typeof id === "string" && id) }
}

function isAdmin(text, userId, nowMs) {
  const parsed = parseAdmins(text)
  if (!parsed || !userId) return { ok: false, reason: "HA administrator list unavailable" }
  const age = Number(nowMs) - parsed.at
  if (!(age >= -60000 && age <= MAX_AGE_MS)) return { ok: false, reason: "HA administrator list is stale" }
  if (parsed.admins.indexOf(userId) < 0) return { ok: false, reason: "HA user is not an administrator" }
  return { ok: true, reason: "" }
}

module.exports = Object.freeze({ MAX_AGE_MS, parseAdmins, isAdmin })
