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
  const userName = e.request.header.get("X-Remote-User-Name") || ""
  const allowed = ($os.getenv("DISCORD_PB_HA_USERS") || "").split(",").map((id) => id.trim()).filter(Boolean)
  // Supervisor does not send an is-admin identity header. This add-on's ingress
  // panel is panel_admin:true, so a trusted ingress request reaching the panel is
  // already admin-gated by HA. Keep this opt-in and off by default.
  const allowPanelAdmin = $os.getenv("DISCORD_PB_HA_ADMINS") === "true"
  if (!user || (!allowPanelAdmin && allowed.indexOf(user) < 0)) {
    return e.json(403, {
      ok: false,
      error: user ? "HA user not allowed" : "HA ingress did not provide a user id",
      haUser: { id: user, name: userName },
      allowlistOption: "auto_login_ha_user_ids",
    })
  }
  const su = $app.findAuthRecordByEmail("_superusers", $os.getenv("DISCORD_PB_ADMIN_EMAIL"))
  return e.json(200, {
    ok: true, key: "__dc_superuser_auth__", token: su.newAuthToken(),
    record: { id: su.getString("id"), email: su.getString("email"), collectionName: "_superusers" }
  })
})
