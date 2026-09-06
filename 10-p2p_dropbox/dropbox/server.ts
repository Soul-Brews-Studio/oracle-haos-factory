import { Hono, type Context } from "hono";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import {
  appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, statSync, unlinkSync, writeFileSync,
} from "fs";
import { timingSafeEqual } from "crypto";
import { adminChecker, readAdminIds } from "./ha-admin";
import type { WsData } from "./types";
import { ingressIdentity, ingressAllowed, ingressApiRoute, mintIngressToken, verifyIngressToken,
  INGRESS_SESSION_TTL_SECONDS, type IngressPolicy } from "./ingress";
import {
  createScopedToken, HEARTBEAT_INTERVAL_MS, sanitizeRoom, SignalingHub, verifyScopedToken,
} from "./signaling";

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads");
const LOG_DIR = resolve(process.env.LOG_DIR || "./logs");
const WEB_DIST = resolve(import.meta.dir, "web-dist");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3847;
const AUTH_KEY = (process.env.AUTH_KEY || "").trim();
const INGRESS_POLICY: IngressPolicy = {
  enabled: process.env.AUTO_LOGIN !== "false", admins: process.env.AUTO_LOGIN_HA_ADMINS !== "false",
  userIds: (process.env.AUTO_LOGIN_HA_USER_IDS || "").split(",").map(id => id.trim()).filter(Boolean),
  // Runtime-only override for an isolated local proof proxy, never a HA option.
  peer: process.env.INGRESS_TRUSTED_PEER || "172.30.32.2",
};
const isHaAdmin = adminChecker(() => readAdminIds(
  process.env.HA_CORE_WS_URL || "ws://supervisor/core/websocket", process.env.SUPERVISOR_TOKEN || ""));
const MAX_FILE_MB = positiveNumber(process.env.MAX_FILE_MB, 10_240);
const MAX_FILE_SIZE = Math.floor(MAX_FILE_MB * 1024 * 1024);
// Hono's multipart parser buffers the request. Bound that memory independently
// from streamed P2P transfers; do not allocate a multi-GiB HTTP form in Bun.
const HTTP_MAX_FILE_SIZE = Math.min(MAX_FILE_SIZE, 32 * 1024 * 1024);
let activeHttpUpload = false;
const SIGNAL_TOKEN_TTL_SECONDS = 300;
const BLOCKED_EXTENSIONS = [".env", ".key", ".pem", ".p12", ".pfx", ".secret", ".credentials"];

if (!AUTH_KEY) {
  console.error("FATAL: AUTH_KEY is not set — refusing to start unauthenticated.");
  process.exit(1);
}

const ICE_SERVERS = parseIceServers();
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`FATAL: MAX_FILE_MB must be a positive number, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return value;
}

function parseIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const raw = process.env.STUN_SERVERS || '["stun:stun.l.google.com:19302"]';
  let stun: unknown;
  try { stun = JSON.parse(raw); } catch {
    console.error("FATAL: STUN_SERVERS must be a JSON array.");
    process.exit(1);
  }
  if (!Array.isArray(stun)) {
    console.error("FATAL: STUN_SERVERS must be a JSON array.");
    process.exit(1);
  }
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = stun.flatMap((entry) => {
    if (typeof entry === "string" && entry.startsWith("stun:")) return [{ urls: entry }];
    if (entry && typeof entry === "object" && "urls" in entry) return [entry as { urls: string | string[] }];
    return [];
  });
  const rawTurn = (process.env.TURN_URLS || process.env.TURN_URL || "").trim();
  const username = process.env.TURN_USER || process.env.TURN_USERNAME || "";
  const credential = process.env.TURN_CRED || process.env.TURN_PASS || process.env.TURN_PASSWORD || "";
  if (rawTurn && username && credential) {
    let urls: string[];
    try {
      const parsed = JSON.parse(rawTurn);
      urls = Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === "string") : [rawTurn];
    } catch {
      urls = rawTurn.split(",").map((url) => url.trim()).filter(Boolean);
    }
    servers.push(...urls.map((url) => ({ urls: url, username, credential })));
  }
  return servers;
}

function accessLog(action: string, detail: string, ip: string) {
  const ts = new Date().toISOString();
  appendFileSync(join(LOG_DIR, `access_${ts.slice(0, 10)}.log`), `${ts}\t${action}\t${ip}\t${detail}\n`);
  console.log(`[${action}] ${detail} (${ip})`);
}

function isSensitive(filename: string): boolean {
  const lower = filename.toLowerCase();
  return BLOCKED_EXTENSIONS.some((extension) => lower.endsWith(extension)) ||
    lower.includes("password") || lower.includes("secret") || lower.includes("credential") ||
    lower.includes(".netrc") || lower.includes("id_rsa") || lower.includes("id_ed25519");
}

function getClientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "local";
}

function keyMatches(candidate: string): boolean {
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(AUTH_KEY);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestKey(c: Context): string {
  const header = c.req.header("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return c.req.query("key") || "";
}

function isDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function isSafeExistingFile(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return false;
    const actual = realpathSync(path);
    const rel = relative(realpathSync(UPLOAD_DIR), actual);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function resolveFilePath(name: string, date?: string): string | null {
  const safeName = basename(name);
  if (safeName !== name || !safeName || safeName.endsWith(".part")) return null;
  const candidates: string[] = [];
  if (date && isDateDir(date)) candidates.push(join(UPLOAD_DIR, date, safeName));
  candidates.push(join(UPLOAD_DIR, safeName));
  for (const entry of readdirSync(UPLOAD_DIR)) {
    if (isDateDir(entry)) candidates.push(join(UPLOAD_DIR, entry, safeName));
  }
  return candidates.find(isSafeExistingFile) || null;
}

function reserveUploadPath(dateDir: string, timestamp: string, safeName: string, bytes: Uint8Array): string {
  const temporary = join(dateDir, `.upload-${crypto.randomUUID()}.part`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o640 });
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const name = `${timestamp}${suffix ? `-${suffix}` : ""}_${safeName}`;
      try {
        linkSync(temporary, join(dateDir, name));
        unlinkSync(temporary);
        return name;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  try { unlinkSync(temporary); } catch {}
  throw new Error("could not reserve a unique upload filename");
}

interface FileInfo { name: string; date: string; size: number; modified: string; sender: string }

function loadIndex(): Map<string, string> {
  const map = new Map<string, string>();
  const path = join(UPLOAD_DIR, "index.jsonl");
  if (!existsSync(path) || !isSafeExistingFile(path)) return map;
  try {
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (typeof entry.savedAs === "string" && typeof entry.sender === "string") map.set(basename(entry.savedAs), entry.sender);
    }
  } catch {}
  return map;
}

function listAllFiles(): FileInfo[] {
  const results: FileInfo[] = [];
  const senders = loadIndex();
  for (const entry of readdirSync(UPLOAD_DIR)) {
    const entryPath = join(UPLOAD_DIR, entry);
    let entryStat;
    try { entryStat = lstatSync(entryPath); } catch { continue; }
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory() && isDateDir(entry)) {
      for (const file of readdirSync(entryPath)) {
        if (file.endsWith(".part")) continue;
        const filePath = join(entryPath, file);
        if (!isSafeExistingFile(filePath)) continue;
        const fileStat = statSync(filePath);
        results.push({ name: file, date: entry, size: fileStat.size, modified: fileStat.mtime.toISOString(), sender: senders.get(file) || "" });
      }
    } else if (entryStat.isFile() && entry !== "index.jsonl" && !entry.endsWith(".part") && isSafeExistingFile(entryPath)) {
      const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
      results.push({ name: entry, date: dateMatch?.[1] || "undated", size: entryStat.size, modified: entryStat.mtime.toISOString(), sender: senders.get(entry) || "" });
    }
  }
  return results.sort((a, b) => b.modified.localeCompare(a.modified));
}

const app = new Hono<{ Bindings: { peerAddress: string; identity: ReturnType<typeof ingressIdentity> }; Variables: { ingressSession: boolean } }>();
app.get("/health", (c) => c.json({ ok: true }));
app.post("/auth/ingress", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "X-Ingress-Path, X-Remote-User-Id");
  const identity = c.env?.identity || null;
  if (!identity || !ingressAllowed(identity, INGRESS_POLICY)) {
    return c.json({ ok: false, ingress: !!identity,
      error: !identity ? "Home Assistant ingress required" : !INGRESS_POLICY.enabled ? "auto_login is off" :
        !identity.user_id ? "HA ingress did not provide a user id" : "HA user not allowed",
      user_id: identity?.user_id || "", user_name: identity?.user_name || "",
      allowlistOption: "auto_login_ha_user_ids",
    }, 403);
  }
  return c.json({ ok: true, ingress: true, token: mintIngressToken(AUTH_KEY, identity, "api"),
    expires_at: Math.floor(Date.now() / 1000) + INGRESS_SESSION_TTL_SECONDS,
    user_id: identity.user_id, user_name: identity.user_name,
  });
});
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const master = keyMatches(requestKey(c));
  const identity = c.env?.identity || null;
  // Session tokens are header-only, scope-limited, and unusable on the direct port
  // or under another HA user/prefix. Existing CLI master-key auth stays unchanged.
  const session = verifyIngressToken((c.req.header("authorization") || "").replace(/^Bearer /i, ""),
    AUTH_KEY, identity, "api", INGRESS_POLICY);
  if (!master && !session) {
    accessLog("AUTH_FAIL", `${c.req.method} ${c.req.path}`, getClientIp(c));
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!master && !ingressApiRoute(c.req.method, c.req.path)) return c.json({ error: "session scope denied" }, 403);
  c.set("ingressSession", !master && session);
  await next();
});

app.get("/api/config", (c) => c.json({
  iceServers: ICE_SERVERS,
  max_file_mb: MAX_FILE_MB,
  http_max_file_mb: HTTP_MAX_FILE_SIZE / 1024 / 1024,
  receiver_peer_name: "p2p-dropbox",
  signal_token: c.get("ingressSession")
    ? mintIngressToken(AUTH_KEY, c.env.identity!, "signal")
    : createScopedToken(AUTH_KEY, "signal", SIGNAL_TOKEN_TTL_SECONDS),
}));

app.get("/api/files", (c) => {
  const files = listAllFiles();
  accessLog("LIST", `${files.length} files`, getClientIp(c));
  return c.json({ files, total: files.length, senders: [...new Set(files.map((file) => file.sender).filter(Boolean))].sort() });
});

app.get("/api/logs", (c) => {
  accessLog("VIEW_LOGS", "access log requested", getClientIp(c));
  const files = readdirSync(LOG_DIR).filter((file) => file.endsWith(".log")).sort().reverse();
  const logs = files.slice(0, 7).flatMap((file) => readFileSync(join(LOG_DIR, file), "utf8").trim().split("\n").filter(Boolean));
  return c.json({ logs: logs.slice(0, 200), total: logs.length });
});

app.use("/api/upload", async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (activeHttpUpload) return c.json({ error: "another HTTP upload is active; retry later" }, 429);
  activeHttpUpload = true;
  try { await next(); } finally { activeHttpUpload = false; }
});
app.post("/api/upload", async (c) => {
  const ip = getClientIp(c);
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > HTTP_MAX_FILE_SIZE + 1024 * 1024) return c.json({ error: `request too large (max HTTP file ${HTTP_MAX_FILE_SIZE / 1024 / 1024} MB)` }, 413);
  let body: Record<string, string | File>;
  try { body = await c.req.parseBody(); } catch { return c.json({ error: "invalid upload body" }, 400); }
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "no file provided" }, 400);
  if (file.size > HTTP_MAX_FILE_SIZE) return c.json({ error: `file too large (HTTP max ${HTTP_MAX_FILE_SIZE / 1024 / 1024} MB)` }, 413);
  const safeName = basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 240) || "upload.bin";
  if (isSensitive(safeName)) return c.json({ error: "sensitive file type blocked for safety" }, 403);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const date = timestamp.slice(0, 10);
  const dateDir = join(UPLOAD_DIR, date);
  mkdirSync(dateDir, { recursive: true, mode: 0o750 });
  const name = reserveUploadPath(dateDir, timestamp, safeName, new Uint8Array(await file.arrayBuffer()));
  const size = statSync(join(dateDir, name)).size;
  accessLog("UPLOAD", `${date}/${name} (${size} bytes)`, ip);
  return c.json({ ok: true, name, date, size });
});

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".csv", ".toml", ".yaml", ".yml", ".sh", ".log", ".rs", ".go"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"]);
const PREVIEW_MAX_LINES = 80;
const PREVIEW_MAX_BYTES = 64 * 1024;

app.get("/api/preview/:name", async (c) => {
  const name = c.req.param("name");
  const path = resolveFilePath(name, c.req.query("date"));
  if (!path) return c.json({ error: "not found" }, 404);
  const extension = extname(name).toLowerCase();
  const size = statSync(path).size;
  const url = `/api/files/${encodeURIComponent(basename(name))}`;
  if (IMAGE_EXTENSIONS.has(extension)) return c.json({ type: "image", url, size });
  if (extension === ".pdf") return c.json({ type: "pdf", url, size });
  if (TEXT_EXTENSIONS.has(extension) || size < PREVIEW_MAX_BYTES) {
    const raw = await Bun.file(path).slice(0, PREVIEW_MAX_BYTES).text();
    const lines = raw.split("\n");
    return c.json({ type: "text", content: lines.slice(0, PREVIEW_MAX_LINES).join("\n"), lines: Math.min(lines.length, PREVIEW_MAX_LINES), totalLines: lines.length, truncated: lines.length > PREVIEW_MAX_LINES || size > PREVIEW_MAX_BYTES });
  }
  return c.json({ type: "binary", size });
});

app.get("/api/files/:name", (c) => {
  const name = c.req.param("name");
  const path = resolveFilePath(name, c.req.query("date"));
  if (!path) return c.json({ error: "not found" }, 404);
  accessLog("DOWNLOAD", `${basename(name)} (${statSync(path).size} bytes)`, getClientIp(c));
  return new Response(Bun.file(path), { headers: {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(name))}`,
    "x-content-type-options": "nosniff",
  } });
});

// Watch pages are deliberately absent in this add-on. Never fall through to the SPA,
// which could accidentally imply that a signal token grants watch/file privileges.
app.get("/watch/*", (c) => c.json({ error: "watch viewer is not enabled" }, 404));

if (existsSync(WEB_DIST)) {
  app.get("/assets/*", async (c) => {
    const path = resolve(WEB_DIST, `.${c.req.path}`);
    if (!path.startsWith(`${WEB_DIST}/`) || !existsSync(path) || lstatSync(path).isSymbolicLink()) return c.notFound();
    return new Response(Bun.file(path), { headers: { "x-content-type-options": "nosniff" } });
  });
  app.get("/manifest.json", () => new Response(Bun.file(join(WEB_DIST, "manifest.json")), { headers: { "content-type": "application/json" } }));
  app.get("/icon-:name", (c) => new Response(Bun.file(join(WEB_DIST, `icon-${basename(c.req.param("name") || "")}`))));
  app.get("*", () => new Response(Bun.file(join(WEB_DIST, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } }));
}

const signaling = new SignalingHub();
const heartbeat = setInterval(() => {
  const removed = signaling.heartbeat();
  if (removed) console.log(`[heartbeat] cleaned ${removed} zombie peer(s)`);
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref?.();

Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: HTTP_MAX_FILE_SIZE + 1024 * 1024,
  async fetch(req, server) {
    const url = new URL(req.url);
    const peerAddress = server.requestIP(req)?.address || "";
    const identity = ingressIdentity(req.headers, peerAddress, INGRESS_POLICY.peer);
    if (identity?.user_id && INGRESS_POLICY.enabled && INGRESS_POLICY.admins &&
        !INGRESS_POLICY.userIds.includes(identity.user_id) &&
        (url.pathname === "/auth/ingress" || url.pathname.startsWith("/api/") || url.pathname === "/ws")) {
      identity.is_admin = await isHaAdmin(identity.user_id);
    }
    if (url.pathname === "/ws") {
      const authorized = keyMatches(url.searchParams.get("key") || "") ||
        verifyScopedToken(url.searchParams.get("token") || "", AUTH_KEY, "signal") ||
        verifyIngressToken(url.searchParams.get("token") || "", AUTH_KEY,
          identity, "signal", INGRESS_POLICY);
      if (!authorized) return new Response("unauthorized", { status: 401 });
      const room = sanitizeRoom(url.searchParams.get("room"));
      if (!room) return new Response("invalid room", { status: 400 });
      if (server.upgrade(req, { data: { id: crypto.randomUUID(), room } })) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return app.fetch(req, { peerAddress, identity });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) { signaling.connect(ws.data.room, ws.data.id, ws); },
    message(ws, message) { signaling.receive(ws.data.room, ws.data.id, message); },
    close(ws) { signaling.disconnect(ws.data.room, ws.data.id); },
  },
});

console.log(`P2P Dropbox listening on ${HOST}:${PORT}; uploads: ${UPLOAD_DIR}; max: ${MAX_FILE_MB} MB`);
