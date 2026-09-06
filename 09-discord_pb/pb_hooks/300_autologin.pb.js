/// <reference path="../pb_data/types.d.ts" />
// Trust the TCP peer, NEVER X-Forwarded-For. No LAN/VPN token vending.
routerAdd("POST", "/api/discord/admin-token", (e) => {
  e.response.header().set("Cache-Control", "no-store")
  if ($os.getenv("DISCORD_PB_AUTO_LOGIN") !== "true") {
    return e.json(403, { ok: false, error: "auto_login is off" })
  }
  const peer = e.remoteIP()
  const ingressPeer = $os.getenv("DISCORD_PB_INGRESS_PEER") || "172.30.32.2"
  const path = e.request.header.get("X-Ingress-Path") || ""
  if (peer !== ingressPeer || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(path)) {
    return e.json(403, { ok: false, error: "Home Assistant ingress required" })
  }
  const user = e.request.header.get("X-Remote-User-Id") || ""
  const allowed = ($os.getenv("DISCORD_PB_HA_USERS") || "").split(",")
  if (!user || allowed.indexOf(user) < 0) return e.json(403, { ok: false, error: "HA user not allowed" })
  const su = $app.findAuthRecordByEmail("_superusers", $os.getenv("DISCORD_PB_ADMIN_EMAIL"))
  return e.json(200, {
    ok: true, key: "__dc_superuser_auth__", token: su.newAuthToken(),
    record: { id: su.getString("id"), email: su.getString("email"), collectionName: "_superusers" }
  })
})
