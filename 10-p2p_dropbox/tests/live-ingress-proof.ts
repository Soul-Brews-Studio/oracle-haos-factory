// Read-only live backend proof through an already-authorized loopback SSH tunnel.
// Existing credentials arrive only over stdin; never print or persist them.
// This does NOT create an ingress session or impersonate a Home Assistant user.
import { readAdminIds } from "../dropbox/ha-admin";
const input = JSON.parse(await Bun.stdin.text());
const supervisor = process.env.P2P_PROOF_SUPERVISOR_URL || "http://127.0.0.1:51460";
const direct = process.env.P2P_PROOF_DIRECT_URL || "http://kvmlab1.oracle.netbird:3847";
if (!input.supervisor_token || !input.auth_key) throw new Error("existing credentials required on stdin");
const ids = await readAdminIds(supervisor.replace("http:", "ws:") + "/core/websocket", input.supervisor_token);
console.log(`REAL_CORE_ADMIN_LOOKUP=PASS count=${ids.size}`);
const unauthenticated = await fetch(direct + "/api/files");
const authenticated = await fetch(direct + "/api/files", {headers: {authorization: `Bearer ${input.auth_key}`}});
const spoofed = await fetch(direct + "/auth/ingress", {method:"POST", headers:{
  "x-ingress-path":"/api/hassio_ingress/proof", "x-remote-user-id":[...ids][0] || "fixture-admin", "x-forwarded-for":"172.30.32.2",
}});
if (unauthenticated.status !== 401 || authenticated.status !== 200 || spoofed.status !== 403) throw new Error("backend gate failed");
console.log("DIRECT_NO_KEY=401");
console.log("DIRECT_WITH_EXISTING_KEY=200");
console.log("DIRECT_FORGED_INGRESS=403");
console.log("PASS live backend gates; ingress auto-connect requires separate browser proof");
