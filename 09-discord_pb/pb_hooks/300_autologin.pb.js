/// <reference path="../pb_data/types.d.ts" />
// Convenience only. Enabling it makes direct port reachability equivalent to
// PocketBase ownership; keep false unless that trade is explicitly accepted.
routerAdd("GET", "/api/discord/admin-token", (e) => {
  if (String($os.getenv("DISCORD_PB_AUTO_LOGIN") || "").toLowerCase() !== "true") {
    return e.json(403, { ok: false, error: "auto_login is off" })
  }
  const email = $os.getenv("DISCORD_PB_ADMIN_EMAIL") || ""
  if (!email) return e.json(409, { ok: false, error: "admin_email is not configured" })
  const su = $app.findAuthRecordByEmail("_superusers", email)
  return e.json(200, {
    ok: true,
    key: "__pb_superuser_auth__",
    token: su.newAuthToken(),
    record: { id: su.getString("id"), email: su.getString("email"), collectionName: "_superusers" }
  })
})
