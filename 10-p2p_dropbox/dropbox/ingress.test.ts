import { test, expect } from "bun:test";
import { ingressIdentity, ingressAllowed, ingressApiRoute, mintIngressToken, verifyIngressToken, type IngressPolicy } from "./ingress";
import { createScopedToken, verifyScopedToken } from "./signaling";
const policy: IngressPolicy = { enabled: true, admins: true, userIds: [], peer: "172.30.32.2" };
const identity = { user_id: "fixture-admin", user_name: "Fixture Admin", path: "/api/hassio_ingress/fixture", is_admin: true };
const headers = new Headers({"x-ingress-path": identity.path, "x-remote-user-id": identity.user_id,
  "x-remote-user-name": identity.user_name, "x-forwarded-for": policy.peer, "x-real-ip": policy.peer,
  "x-remote-user-is-admin": "true"});
const secret = crypto.randomUUID();
test("ingress requires actual socket peer and valid path; headers cannot grant admin", () => {
  expect(ingressIdentity(headers, policy.peer, policy.peer)).toEqual({user_id:identity.user_id, user_name:identity.user_name, path:identity.path});
  expect(ingressIdentity(headers, "::ffff:172.30.32.2", policy.peer)?.user_id).toBe(identity.user_id);
  for (const peer of [undefined, "127.0.0.1", "172.30.32.1", "100.97.192.167"]) expect(ingressIdentity(headers, peer, policy.peer)).toBeNull();
  for (const path of ["", "/", "/api/hassio_ingress/../fixture", identity.path + "?key=x"]) {
    const forged = new Headers(headers); forged.set("x-ingress-path", path);
    expect(ingressIdentity(forged, policy.peer, policy.peer)).toBeNull();
  }
});
test("auto-login requires enabled policy, identity and verified admin or exact allowlist", () => {
  expect(ingressAllowed(identity, policy)).toBeTrue();
  expect(ingressAllowed(identity, {...policy, enabled: false})).toBeFalse();
  expect(ingressAllowed(null, policy)).toBeFalse();
  expect(ingressAllowed({...identity, user_id: ""}, policy)).toBeFalse();
  expect(ingressAllowed({...identity, is_admin: false}, policy)).toBeFalse();
  expect(ingressAllowed(ingressIdentity(headers, policy.peer, policy.peer), policy)).toBeFalse();
  expect(ingressAllowed(identity, {...policy, admins: false})).toBeFalse();
  expect(ingressAllowed(identity, {...policy, admins: false, userIds: [identity.user_id]})).toBeTrue();
  expect(ingressAllowed(identity, {...policy, admins: false, userIds: [identity.user_id + "x"]})).toBeFalse();
});
test("HA token binds audience, scope, identity, prefix, expiry and live policy without key disclosure", () => {
  const now = 1_800_000_000_000;
  const token = mintIngressToken(secret, identity, "api", now);
  expect(token).not.toContain(secret);
  expect(Buffer.from(token.split(".")[0], "base64url").toString()).not.toContain(secret);
  expect(verifyIngressToken(token, secret, identity, "api", policy, now)).toBeTrue();
  expect(verifyIngressToken(token, secret, identity, "api", policy, now + 300_000)).toBeFalse();
  expect(verifyIngressToken(token, secret, identity, "signal", policy, now)).toBeFalse();
  expect(verifyIngressToken(token, secret, {...identity, user_id: "other"}, "api", policy, now)).toBeFalse();
  expect(verifyIngressToken(token, secret, {...identity, path: identity.path + "2"}, "api", policy, now)).toBeFalse();
  expect(verifyIngressToken(token, secret, null, "api", policy, now)).toBeFalse();
  expect(verifyIngressToken(token, secret, identity, "api", {...policy, enabled: false}, now)).toBeFalse();
  expect(verifyIngressToken(token, secret, identity, "api", {...policy, admins: false}, now)).toBeFalse();
  for (const bad of [token + "x", token + ".extra", "garbage", createScopedToken(secret, "watch", 300, now), createScopedToken(secret, "signal", 300, now)]) expect(verifyIngressToken(bad, secret, identity, "api", policy, now)).toBeFalse();
  expect(verifyScopedToken(token, secret, "signal", now)).toBeFalse();
});
test("API session scope excludes logs, unknown routes and mutations other than upload", () => {
  for (const path of ["/api/config", "/api/files", "/api/files/test.txt", "/api/preview/test.txt"]) expect(ingressApiRoute("GET", path)).toBeTrue();
  expect(ingressApiRoute("POST", "/api/upload")).toBeTrue();
  for (const path of ["/api/logs", "/api/admin", "/api/files/test/extra"]) expect(ingressApiRoute("GET", path)).toBeFalse();
  expect(ingressApiRoute("DELETE", "/api/files/test.txt")).toBeFalse();
});
