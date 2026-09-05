import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia, t } from "elysia";
import { node } from "@elysia/node";
import { openapi } from "@elysia/openapi";
import { ControlDb, type BotInput, type BotPatch } from "./control-db.js";

export interface GatewayOptions {
  archiveOrigin?: string;
  controlDb?: string;
  controlKey?: string;
  staticDir?: string;
  fetch?: typeof globalThis.fetch;
}

const BotId = t.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$", examples: ["line"] });
const NullableString = t.Union([t.String(), t.Null()]);
const MaskedBotSchema = t.Object({
  id: BotId,
  name: t.String(),
  has_secret: t.Boolean(),
  has_token: t.Boolean(),
  bot_user_id: NullableString,
  enabled: t.Boolean(),
  created_at: t.String({ format: "date-time" }),
  updated_at: t.String({ format: "date-time" })
});
const BotCreateSchema = t.Object({
  id: BotId,
  name: t.String({ minLength: 1, maxLength: 128 }),
  channel_secret: t.Optional(NullableString),
  channel_access_token: t.Optional(NullableString),
  bot_user_id: t.Optional(NullableString),
  enabled: t.Optional(t.Boolean())
});
const BotPatchSchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  channel_secret: t.Optional(NullableString),
  channel_access_token: t.Optional(NullableString),
  bot_user_id: t.Optional(NullableString),
  enabled: t.Optional(t.Boolean())
});
const IntentHeaders = t.Object({
  "x-ingress-path": t.Optional(t.String({ description: "Home Assistant Ingress path injected by Supervisor" })),
  "x-remote-user-id": t.Optional(t.String({ description: "Authenticated Home Assistant user injected by Supervisor" })),
  "x-line-lance-intent": t.Optional(t.String({ description: "Must equal manage-bots for mutations" }))
});
const ErrorSchema = t.Object({ error: t.String() });
const BOT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ARCHIVE_PATHS = new Set([
  "/api/health", "/api/stats", "/api/chats", "/api/tables", "/api/messages", "/api/semantic"
]);
const ARCHIVE_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createGateway(options: GatewayOptions = {}) {
  const archiveOrigin = withoutTrailingSlash(options.archiveOrigin ?? process.env.ARCHIVE_ORIGIN ?? "http://127.0.0.1:4133");
  const controlDbPath = options.controlDb ?? process.env.CONTROL_DB ?? "/data/line-lance-control.sqlite";
  const controlKeyPath = options.controlKey ?? process.env.CONTROL_KEY ?? "/data/line-lance-control.key";
  // Compiled code lives at gateway/dist/src; the React build is a sibling of gateway.
  const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? fileURLToPath(new URL("../../../frontend/dist", import.meta.url)));
  const fetcher = options.fetch ?? globalThis.fetch;
  const control = new ControlDb(controlDbPath, controlKeyPath);

  const app = new Elysia({ adapter: node() })
    .decorate("control", control)
    // Keep write rejection out of route registration so OpenAPI truthfully
    // publishes GET only while runtime writes still receive Python's contract.
    .onRequest(({ request }) => {
      if (ARCHIVE_WRITE_METHODS.has(request.method) && ARCHIVE_PATHS.has(new URL(request.url).pathname)) {
        return archiveMethodNotAllowed();
      }
    })
    .use(openapi({
      path: "/api/openapi",
      specPath: "/api/openapi/json",
      provider: "scalar",
      scalar: {
        // Scalar resolves this against the current HA Ingress URL. An absolute
        // `/api/...` would escape the Supervisor prefix; the plugin's derived
        // value duplicates `/api` here, so override it explicitly.
        url: "./openapi/json",
        version: "1.67.0"
      },
      documentation: {
        info: {
          title: "LINE Lance Gateway",
          version: "0.3.0",
          description: "Local Elysia control plane and read-only Python LanceDB archive gateway. Bot credentials are write-only."
        },
        tags: [
          { name: "Archive", description: "Proxied read-only archive API" },
          { name: "Bots", description: "Local encrypted LINE bot registry" }
        ]
      }
    }))
    .get("/api/health", async ({ request, status }) => {
      const response = await proxyArchive(request, archiveOrigin, fetcher);
      if (!response.ok) return status(502, { error: "archive_unavailable" });
      try {
        const archive = await response.json() as Record<string, unknown>;
        return {
          ...archive,
          status: typeof archive.status === "string" ? archive.status : "ok",
          backend: "elysia" as const,
          archive_engine: "python-lancedb" as const
        };
      } catch {
        return status(502, { error: "invalid_archive_health" });
      }
    }, {
      response: {
        200: t.Object({
          status: t.String(),
          slug: t.Optional(t.String()),
          version: t.Optional(t.String()),
          database: t.Optional(t.String()),
          messages: t.Optional(t.Number()),
          vectors: t.Optional(t.Number()),
          backend: t.Literal("elysia"),
          archive_engine: t.Literal("python-lancedb")
        }),
        502: ErrorSchema
      },
      detail: { summary: "Gateway and archive health", tags: ["Archive"] }
    })
    .get("/api/stats", ({ request }) => proxyArchive(request, archiveOrigin, fetcher), archiveProxyDetail("Archive statistics"))
    .get("/api/chats", ({ request }) => proxyArchive(request, archiveOrigin, fetcher), archiveProxyDetail("Archive chats"))
    .get("/api/tables", ({ request }) => proxyArchive(request, archiveOrigin, fetcher), archiveProxyDetail("Archive table metadata"))
    .get("/api/messages", ({ request }) => proxyArchive(request, archiveOrigin, fetcher), archiveProxyDetail("Archive messages"))
    .get("/api/semantic", ({ request }) => proxyArchive(request, archiveOrigin, fetcher), archiveProxyDetail("Archive semantic search"))
    .get("/api/bots", ({ headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      return { bots: db.list() };
    }, {
      headers: IntentHeaders,
      response: { 200: t.Object({ bots: t.Array(MaskedBotSchema) }), 403: ErrorSchema },
      detail: { summary: "List bots with masked credential flags", tags: ["Bots"] }
    })
    .post("/api/bots", ({ body, headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      if (!hasManageIntent(headers)) return status(403, { error: "manage_bots_intent_required" });
      const input = normalizeCreate(body);
      if (!input.name) return status(400, { error: "invalid_name" });
      const result = db.create(input);
      return status(result.created ? 201 : 200, result.bot);
    }, {
      body: BotCreateSchema,
      headers: IntentHeaders,
      response: { 200: MaskedBotSchema, 201: MaskedBotSchema, 400: ErrorSchema, 403: ErrorSchema },
      detail: {
        summary: "Create or replace a bot",
        description: "Credentials are write-only, encrypted at rest, and retained when omitted. Send null to clear one.",
        tags: ["Bots"]
      }
    })
    .get("/api/bots/:id", ({ params, headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      if (!BOT_ID_PATTERN.test(params.id)) return status(400, { error: "invalid_bot_id" });
      return db.get(params.id) ?? status(404, { error: "bot_not_found" });
    }, {
      params: t.Object({ id: t.String() }),
      headers: IntentHeaders,
      response: { 200: MaskedBotSchema, 400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      detail: { summary: "Get one masked bot", tags: ["Bots"] }
    })
    .patch("/api/bots/:id", ({ params, body, headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      if (!hasManageIntent(headers)) return status(403, { error: "manage_bots_intent_required" });
      if (!BOT_ID_PATTERN.test(params.id)) return status(400, { error: "invalid_bot_id" });
      const patch = normalizePatch(body);
      if (patch.name !== undefined && !patch.name) return status(400, { error: "invalid_name" });
      const bot = db.update(params.id, patch);
      return bot ?? status(404, { error: "bot_not_found" });
    }, {
      params: t.Object({ id: t.String() }),
      body: BotPatchSchema,
      headers: IntentHeaders,
      response: { 200: MaskedBotSchema, 400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      detail: {
        summary: "Update selected bot fields",
        description: "Omitted values are retained; explicit null clears nullable credential or user-id fields.",
        tags: ["Bots"]
      }
    })
    .put("/api/bots/:id", ({ params, body, headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      if (!hasManageIntent(headers)) return status(403, { error: "manage_bots_intent_required" });
      if (!BOT_ID_PATTERN.test(params.id)) return status(400, { error: "invalid_bot_id" });
      const patch = normalizePatch(body);
      if (patch.name !== undefined && !patch.name) return status(400, { error: "invalid_name" });
      const bot = db.update(params.id, patch);
      return bot ?? status(404, { error: "bot_not_found" });
    }, {
      params: t.Object({ id: t.String() }),
      body: BotPatchSchema,
      headers: IntentHeaders,
      response: { 200: MaskedBotSchema, 400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      detail: { summary: "Replace supplied bot fields", tags: ["Bots"] }
    })
    .delete("/api/bots/:id", ({ params, headers, control: db, status }) => {
      if (!hasIngressIdentity(headers)) return status(403, { error: "ingress_identity_required" });
      if (!hasManageIntent(headers)) return status(403, { error: "manage_bots_intent_required" });
      if (!BOT_ID_PATTERN.test(params.id)) return status(400, { error: "invalid_bot_id" });
      if (!db.delete(params.id)) return status(404, { error: "bot_not_found" });
      return { ok: true };
    }, {
      params: t.Object({ id: t.String() }),
      headers: IntentHeaders,
      response: {
        200: t.Object({ ok: t.Literal(true) }),
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema
      },
      detail: { summary: "Delete a bot", tags: ["Bots"] }
    })
    .get("/*", ({ request }) => serveStatic(request, staticDir), {
      detail: { hide: true }
    });

  return Object.assign(app, { closeControlDb: () => control.close(), controlDb: control });
}

async function proxyArchive(request: Request, origin: string, fetcher: typeof globalThis.fetch): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${origin}/`);
  // The Python archive receives no HA identity, session, authorization,
  // proxy/forwarded, intent, content metadata, or request body.
  const init: RequestInit = { method: request.method, headers: new Headers(), redirect: "manual" };
  try {
    const response = await fetcher(target, init);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    return Response.json({ error: "archive_unavailable" }, { status: 502 });
  }
}

function archiveMethodNotAllowed(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET" } });
}

function serveStatic(request: Request, staticDir: string): Response {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (pathname.includes("\0") || pathname.split("/").some((part) => part === ".." || part === ".")) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const candidate = resolve(staticDir, `.${pathname}`);
  if (!inside(staticDir, candidate)) return Response.json({ error: "not_found" }, { status: 404 });
  const target = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(staticDir, "index.html");
  if (!inside(staticDir, target) || !existsSync(target) || !statSync(target).isFile()) {
    return Response.json({ error: "frontend_missing" }, { status: 503 });
  }
  const headers = new Headers({
    "content-type": mimeType(target),
    "x-content-type-options": "nosniff"
  });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(readFileSync(target), { headers });
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function mimeType(path: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2"
  } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function normalizeCreate(body: typeof BotCreateSchema.static): BotInput {
  const normalized: BotInput = { id: body.id.trim(), name: body.name.trim() };
  if (body.enabled !== undefined) normalized.enabled = body.enabled;
  if (Object.hasOwn(body, "channel_secret")) normalized.channel_secret = cleanNullable(body.channel_secret);
  if (Object.hasOwn(body, "channel_access_token")) normalized.channel_access_token = cleanNullable(body.channel_access_token);
  if (Object.hasOwn(body, "bot_user_id")) normalized.bot_user_id = cleanNullable(body.bot_user_id);
  return normalized;
}

function normalizePatch(body: typeof BotPatchSchema.static): BotPatch {
  const normalized: BotPatch = {};
  if (body.name !== undefined) normalized.name = body.name.trim();
  if (body.enabled !== undefined) normalized.enabled = body.enabled;
  if (Object.hasOwn(body, "channel_secret")) normalized.channel_secret = cleanNullable(body.channel_secret);
  if (Object.hasOwn(body, "channel_access_token")) normalized.channel_access_token = cleanNullable(body.channel_access_token);
  if (Object.hasOwn(body, "bot_user_id")) normalized.bot_user_id = cleanNullable(body.bot_user_id);
  return normalized;
}

function cleanNullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() || null;
}

function hasManageIntent(headers: Record<string, string | undefined>): boolean {
  return headers["x-line-lance-intent"] === "manage-bots";
}

function hasIngressIdentity(headers: Record<string, string | undefined>): boolean {
  return Boolean(headers["x-ingress-path"]?.trim() && headers["x-remote-user-id"]?.trim());
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function archiveProxyDetail(summary: string) {
  return {
    detail: {
      summary,
      description: "Forwards a headerless GET and preserves the response. Write methods are rejected locally with 405.",
      tags: ["Archive"]
    }
  };
}
