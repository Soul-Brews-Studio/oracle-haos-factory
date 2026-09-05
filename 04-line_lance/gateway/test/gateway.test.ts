import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGateway, type GatewayOptions } from "../src/app.js";

const INGRESS = {
  "x-ingress-path": "/api/hassio_ingress/test",
  "x-remote-user-id": "test-user"
};
const MANAGE = { ...INGRESS, "x-line-lance-intent": "manage-bots" };

function fixture(overrides: GatewayOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "line-lance-gateway-"));
  const staticDir = join(root, "dist");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>LINE Lance test shell</title>");
  writeFileSync(join(staticDir, "assets", "app.js"), "globalThis.fixture = true;");
  const controlDb = join(root, "control.sqlite");
  const controlKey = join(root, "control.key");
  const app = createGateway({ staticDir, controlDb, controlKey, ...overrides });
  return { app, root, staticDir, controlDb, controlKey };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://gateway.test${path}`, init);
}

test("bot CRUD is ingress-gated, intent-gated, masked, and v3-validated", async (t) => {
  const fx = fixture();
  t.after(() => fx.app.closeControlDb());

  assert.equal((await fx.app.handle(request("/api/bots"))).status, 403);
  assert.equal((await fx.app.handle(request("/api/bots", { headers: { "x-ingress-path": "/only-one" } }))).status, 403);
  assert.equal((await fx.app.handle(request("/api/bots", { headers: INGRESS }))).status, 200);

  const payload = {
    id: "line_main",
    name: " Main LINE bot ",
    channel_secret: "super-secret-value",
    channel_access_token: "super-token-value",
    bot_user_id: "U123",
    enabled: true
  };
  const denied = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...INGRESS, "content-type": "application/json" }, body: JSON.stringify(payload)
  }));
  assert.equal(denied.status, 403);

  const created = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" }, body: JSON.stringify(payload)
  }));
  assert.equal(created.status, 201);
  const createdBody = await json(created);
  assert.deepEqual({
    id: createdBody.id,
    name: createdBody.name,
    has_secret: createdBody.has_secret,
    has_token: createdBody.has_token,
    bot_user_id: createdBody.bot_user_id,
    enabled: createdBody.enabled
  }, {
    id: "line_main", name: "Main LINE bot", has_secret: true, has_token: true,
    bot_user_id: "U123", enabled: true
  });
  assert.equal("channel_secret" in createdBody, false);
  assert.equal("channel_access_token" in createdBody, false);

  const listed = await json(await fx.app.handle(request("/api/bots", { headers: INGRESS })));
  assert.equal(JSON.stringify(listed).includes("super-secret-value"), false);
  assert.equal(JSON.stringify(listed).includes("super-token-value"), false);

  const retained = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({ id: "line_main", name: "Renamed" })
  }));
  assert.equal(retained.status, 200);
  assert.equal(fx.app.controlDb.credential("line_main", "channel_secret"), "super-secret-value");
  assert.equal(fx.app.controlDb.credential("line_main", "channel_access_token"), "super-token-value");

  const cleared = await fx.app.handle(request("/api/bots/line_main", {
    method: "PATCH", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({ channel_secret: null })
  }));
  assert.equal(cleared.status, 200);
  assert.equal((await json(cleared)).has_secret, false);
  assert.equal(fx.app.controlDb.credential("line_main", "channel_secret"), null);
  assert.equal(fx.app.controlDb.credential("line_main", "channel_access_token"), "super-token-value");

  const invalid = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({ id: "bad id!", name: "x" })
  }));
  assert.equal(invalid.status, 422);
  const blankName = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({ id: "valid", name: "" })
  }));
  assert.equal(blankName.status, 422);
  const whitespaceName = await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({ id: "valid", name: "   " })
  }));
  assert.equal(whitespaceName.status, 400);

  assert.equal((await fx.app.handle(request("/api/bots/line_main", { method: "DELETE", headers: INGRESS }))).status, 403);
  assert.equal((await fx.app.handle(request("/api/bots/line_main", { method: "DELETE", headers: MANAGE }))).status, 200);
  assert.equal((await fx.app.handle(request("/api/bots/line_main", { headers: INGRESS }))).status, 404);
});

test("credentials are AES-GCM envelopes, files are 0600, and restart preserves secrets", async () => {
  const fx = fixture();
  await fx.app.handle(request("/api/bots", {
    method: "POST", headers: { ...MANAGE, "content-type": "application/json" },
    body: JSON.stringify({
      id: "secure", name: "Secure", channel_secret: "plaintext-secret", channel_access_token: "plaintext-token"
    })
  }));
  assert.equal(statSync(fx.controlDb).mode & 0o777, 0o600);
  assert.equal(statSync(fx.controlKey).mode & 0o777, 0o600);
  const raw = readFileSync(fx.controlDb);
  assert.equal(raw.includes(Buffer.from("plaintext-secret")), false);
  assert.equal(raw.includes(Buffer.from("plaintext-token")), false);
  assert.equal(raw.includes(Buffer.from("v1:aes-256-gcm:")), true);
  fx.app.closeControlDb();

  const restarted = createGateway({
    staticDir: fx.staticDir, controlDb: fx.controlDb, controlKey: fx.controlKey,
    fetch: async () => Response.json({ status: "ok" })
  });
  try {
    assert.equal(restarted.controlDb.credential("secure", "channel_secret"), "plaintext-secret");
    assert.equal(restarted.controlDb.credential("secure", "channel_access_token"), "plaintext-token");
    const bot = await json(await restarted.handle(request("/api/bots/secure", { headers: INGRESS })));
    assert.equal(bot.has_secret, true);
    assert.equal(bot.has_token, true);
    assert.equal(JSON.stringify(bot).includes("plaintext"), false);
  } finally {
    restarted.closeControlDb();
  }
});

test("archive proxy preserves route/query/status and augments health", async (t) => {
  const seen: Array<{ call: string; headers: Array<[string, string]>; hasBody: boolean }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    seen.push({
      call: `${init?.method ?? "GET"} ${url.toString()}`,
      headers: [...new Headers(init?.headers).entries()],
      hasBody: init?.body !== undefined && init.body !== null
    });
    if (url.pathname === "/api/health") return Response.json({ status: "ok", messages: 11956, vectors: 0 });
    return Response.json({ proxied: true, query: url.search }, { status: 206, headers: { "x-archive": "yes" } });
  };
  const fx = fixture({ archiveOrigin: "http://127.0.0.1:4133/", fetch: fetcher });
  t.after(() => fx.app.closeControlDb());

  const health = await json(await fx.app.handle(request("/api/health")));
  assert.equal(health.backend, "elysia");
  assert.equal(health.archive_engine, "python-lancedb");
  assert.equal(health.messages, 11956);

  const sentinelHeaders = {
    authorization: "Bearer sentinel-auth",
    cookie: "session=sentinel-cookie",
    "content-type": "application/sentinel",
    "content-length": "999",
    "x-ingress-path": "/sentinel-ingress",
    "x-remote-user-id": "sentinel-user",
    "x-line-lance-intent": "sentinel-intent",
    forwarded: "for=sentinel-forwarded",
    "x-forwarded-for": "sentinel-xff",
    "x-real-ip": "sentinel-real-ip",
    "proxy-authorization": "sentinel-proxy-auth"
  };
  const proxied = await fx.app.handle(request("/api/messages?q=thai&limit=7", { headers: sentinelHeaders }));
  assert.equal(proxied.status, 206);
  assert.equal(proxied.headers.get("x-archive"), "yes");
  assert.deepEqual(await json(proxied), { proxied: true, query: "?q=thai&limit=7" });
  assert.deepEqual(seen, [
    { call: "GET http://127.0.0.1:4133/api/health", headers: [], hasBody: false },
    { call: "GET http://127.0.0.1:4133/api/messages?q=thai&limit=7", headers: [], hasBody: false }
  ]);

  for (const path of ["/api/health", "/api/messages"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const write = await fx.app.handle(request(path, {
        method,
        headers: sentinelHeaders,
        body: "sentinel-secret-body"
      }));
      assert.equal(write.status, 405, `${method} ${path}`);
      assert.equal(write.headers.get("allow"), "GET", `${method} ${path}`);
      assert.deepEqual(await json(write), { error: "method not allowed" });
    }
  }
  assert.equal(seen.length, 2, "archive writes must not call fetch");
  assert.equal((await fx.app.handle(request("/api/not-an-archive-route"))).status, 404);
});

test("OpenAPI exposes Scalar and explicit bot contracts", async (t) => {
  const fx = fixture();
  t.after(() => fx.app.closeControlDb());
  const ui = await fx.app.handle(request("/api/openapi"));
  assert.equal(ui.status, 200);
  const html = await ui.text();
  assert.match(html, /scalar/i);
  assert.match(html, /"url":"\.\/openapi\/json"/);
  assert.doesNotMatch(html, /\/api\/api\/openapi\/json/);
  assert.match(html, /@scalar\/api-reference@1\.67\.0\/dist\/browser\/standalone\.min\.js/);
  assert.doesNotMatch(html, /@scalar\/api-reference@latest/);
  const ingressBase = "https://ha.example/api/hassio_ingress/token/api/openapi";
  assert.equal(
    new URL("./openapi/json", ingressBase).pathname,
    "/api/hassio_ingress/token/api/openapi/json"
  );

  const specResponse = await fx.app.handle(request("/api/openapi/json"));
  assert.equal(specResponse.status, 200);
  const spec = await specResponse.json() as {
    paths: Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
  };
  assert.ok(spec.paths["/api/bots"]?.get);
  assert.ok(spec.paths["/api/bots"]?.post);
  assert.ok(spec.paths["/api/bots/{id}"]?.patch);
  assert.ok(spec.paths["/api/bots/{id}"]?.delete);
  for (const path of [
    "/api/health", "/api/stats", "/api/chats", "/api/tables", "/api/messages", "/api/semantic"
  ]) {
    assert.deepEqual(Object.keys(spec.paths[path] ?? {}).sort(), ["get"], `${path} must advertise GET only`);
  }
  const headerNames = spec.paths["/api/bots"]?.post?.parameters?.map((entry) => entry.name) ?? [];
  assert.ok(headerNames.includes("x-ingress-path"));
  assert.ok(headerNames.includes("x-remote-user-id"));
  assert.ok(headerNames.includes("x-line-lance-intent"));
});

test("static assets use traversal-safe SPA fallback", async (t) => {
  const fx = fixture();
  t.after(() => fx.app.closeControlDb());
  const asset = await fx.app.handle(request("/assets/app.js"));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.match(await asset.text(), /fixture/);

  const spa = await fx.app.handle(request("/chat/line"));
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /LINE Lance test shell/);
  const traversal = await fx.app.handle(request("/assets/%2e%2e/%2e%2e/etc/passwd"));
  assert.equal(traversal.status, 200);
  assert.match(await traversal.text(), /LINE Lance test shell/);
});
