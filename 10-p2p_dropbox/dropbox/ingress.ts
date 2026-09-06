import { createHmac, timingSafeEqual } from "node:crypto";

export const INGRESS_SESSION_TTL_SECONDS = 300;
const AUDIENCE = "p2p-dropbox-ha-ingress-v1";
export interface IngressIdentity { user_id: string; user_name: string; path: string; is_admin?: boolean }
export interface IngressPolicy { enabled: boolean; admins: boolean; userIds: string[]; peer: string }
export type IngressScope = "api" | "signal";

// Only the socket peer proves proxy provenance. Forwarded headers never do.
export function ingressIdentity(headers: Headers, peer: string | undefined, trustedPeer: string): IngressIdentity | null {
  if (peer?.replace(/^::ffff:/, "") !== trustedPeer) return null;
  const path = headers.get("x-ingress-path") || "";
  if (!/^\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,256}$/.test(path)) return null;
  const id = headers.get("x-remote-user-id") || "";
  return {
    path, user_id: /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "",
    user_name: (headers.get("x-remote-user-name") || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128),
  };
}

export function ingressAllowed(identity: IngressIdentity | null, policy: IngressPolicy): boolean {
  // Role comes only from the server-side HA Core lookup, never an ingress header.
  return policy.enabled && !!identity?.user_id && ((policy.admins && identity.is_admin === true) || policy.userIds.includes(identity.user_id));
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${AUDIENCE}:${payload}`).digest();
}

export function mintIngressToken(secret: string, identity: IngressIdentity, scope: IngressScope, nowMs = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ aud: AUDIENCE, sub: identity.user_id, path: identity.path,
    scope, exp: Math.floor(nowMs / 1000) + INGRESS_SESSION_TTL_SECONDS })).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifyIngressToken(token: string, secret: string, identity: IngressIdentity | null,
  scope: IngressScope, policy: IngressPolicy, nowMs = Date.now()): boolean {
  if (!ingressAllowed(identity, policy) || !identity || token.length > 2048) return false;
  const [payload, encoded, extra] = token.split(".");
  if (!payload || !encoded || extra) return false;
  try {
    const actual = Buffer.from(encoded, "base64url");
    const expected = signature(payload, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const c = JSON.parse(Buffer.from(payload, "base64url").toString());
    const now = Math.floor(nowMs / 1000);
    return c.aud === AUDIENCE && c.scope === scope && c.sub === identity.user_id && c.path === identity.path &&
      Number.isInteger(c.exp) && c.exp > now && c.exp <= now + INGRESS_SESSION_TTL_SECONDS;
  } catch { return false; }
}

export function ingressApiRoute(method: string, path: string): boolean {
  return (method === "GET" && (path === "/api/config" || path === "/api/files" ||
    /^\/api\/(files|preview)\/[^/]+$/.test(path))) || (method === "POST" && path === "/api/upload");
}
