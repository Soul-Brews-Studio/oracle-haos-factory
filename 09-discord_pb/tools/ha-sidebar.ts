#!/usr/bin/env bun
/**
 * Mirror the archive's servers into the Home Assistant sidebar, one entry per
 * Discord server, using HA's own dashboard API (the same websocket calls the
 * Settings > Dashboards page makes). Each entry is a storage dashboard whose
 * config is the "iframe" strategy pointing at this add-on's ingress entry with
 * ?guild=<id>, so it opens straight into that server's rooms.
 *
 *   bun tools/ha-sidebar.ts --ip HOST --user U --pass-file F list
 *   bun tools/ha-sidebar.ts ... servers                 # what the add-on knows (via ingress)
 *   bun tools/ha-sidebar.ts ... pin GUILD_ID [TITLE]    # add one server to the HA sidebar
 *   bun tools/ha-sidebar.ts ... sync                    # pin every open server, hide hidden ones
 *   bun tools/ha-sidebar.ts ... pin-timeline [TITLE]   # the central timeline as dc-timeline
 *   bun tools/ha-sidebar.ts ... hide URL_PATH | show URL_PATH | unpin URL_PATH
 *
 * The credential is read from --pass-file only; it never appears in argv.
 * Dashboards created here use url_path "dc-<guild id>" so sync can find them
 * again and never touches dashboards it did not create. "dc-timeline" is the
 * one non-server dc-* entry; sync skips it.
 *
 * Ingress caveat, measured 2026-09-07 on HA 2026.8.3: an iframe under
 * /api/hassio_ingress/... is served only while the browser holds a live
 * ingress_session cookie. HA creates that cookie when any add-on panel is
 * opened and it stays valid 15 minutes after the last validation; the embedded
 * page then keeps it alive itself every 60 s while it is open (simple.js
 * keepIngressAlive). So: open "Discord Archive" once, then the pinned server
 * entries work; if one shows "401: Unauthorized", open the main panel again.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const need = (n: string) => flag(n) ?? die(`--${n} is required`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [command = "list", ...rest] = positional;
const SLUG = flag("slug") ?? "local_discord_pb";
const PREFIX = "dc-";
// dc-* paths that are not "one server": sync leaves them alone.
const RESERVED = new Set([`${PREFIX}timeline`]);

const ip = need("ip"), user = need("user");
const pass = ((): string => {
  const file = need("pass-file");
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch (e) { return die(`--pass-file ${file} unreadable: ${(e as Error).message}`); }
  return raw.replace(/\r?\n$/, "") || die(`--pass-file ${file} is empty`);
})();
const base = `http://${ip}`, clientId = `${base}/`;

async function post<T>(path: string, body: unknown, form = false): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json() as T;
}
async function accessToken(): Promise<string> {
  const start = await post<{ flow_id?: string }>("/auth/login_flow", { client_id: clientId, handler: ["homeassistant", null], redirect_uri: clientId });
  if (!start.flow_id) throw new Error("no login flow");
  const done = await post<{ type?: string; result?: string }>(`/auth/login_flow/${start.flow_id}`, { client_id: clientId, username: user, password: pass });
  if (done.type !== "create_entry" || !done.result) throw new Error(`login rejected for ${user}`);
  const tok = await post<{ access_token?: string }>("/auth/token", { grant_type: "authorization_code", code: done.result, client_id: clientId }, true);
  return tok.access_token ?? die("no access token");
}

type Reply = { id?: number; type?: string; success?: boolean; result?: unknown; error?: { message?: string } };
async function websocket(token: string) {
  const ws = new WebSocket(`ws://${ip}/api/websocket`);
  let id = 0;
  const pending = new Map<number, (r: Reply) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("websocket connection failed"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Reply;
      if (m.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: token }));
      if (m.type === "auth_ok") return resolve();
      if (m.type === "auth_invalid") return reject(new Error("websocket authentication failed"));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    };
  });
  const send = <T = unknown>(msg: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => { pending.delete(rid); reject(new Error("websocket request timed out")); }, 30_000);
    pending.set(rid, (r) => { clearTimeout(t); r.success ? resolve(r.result as T) : reject(new Error(r.error?.message ?? "websocket request failed")); });
    ws.send(JSON.stringify({ id: rid, ...msg }));
  });
  const sup = <T = any>(endpoint: string, method = "get", data?: unknown) => send<T>({ type: "supervisor/api", endpoint, method, ...(data !== undefined ? { data } : {}) });
  return { send, sup, close: () => ws.close() };
}

type Dashboard = { id: string; url_path: string; title: string; icon?: string; show_in_sidebar: boolean; require_admin: boolean; mode: string };
type Guild = { id: string; name: string; hidden: boolean; open: boolean; imported_count: number; channel_count: number };

async function main() {
  const ha = await websocket(await accessToken());
  const info = await ha.sup<{ ingress_entry?: string; ingress?: boolean }>(`/addons/${SLUG}/info`);
  if (!info?.ingress || !info.ingress_entry) die(`${SLUG} has no ingress`);
  const entry = info.ingress_entry;
  const dashboards = async () => (await ha.send<Dashboard[]>({ type: "lovelace/dashboards/list" })).filter((d) => d.url_path.startsWith(PREFIX));
  const frameUrl = (guild: string) => `${entry}/simple.html?guild=${encodeURIComponent(guild)}`;

  // The add-on's own view of its servers, fetched through real ingress (same
  // path the browser uses), so this tool needs no PocketBase credential.
  const servers = async (): Promise<Guild[]> => {
    const session = (await ha.sup<{ session?: string }>("/ingress/session", "post"))?.session ?? die("could not open an ingress session");
    const headers: Record<string, string> = { Cookie: `ingress_session=${session}` };
    const auth = await fetch(`${base}${entry}/api/discord/admin-token`, { method: "POST", headers });
    const body = await auth.json() as { token?: string; error?: string };
    if (!auth.ok || !body.token) die(`add-on refused auto-login: ${body.error ?? auth.status} (enable auto_login / allow this HA user)`);
    const payload = await fetch(`${base}${entry}/api/dc/sidebar`, { headers: { ...headers, Authorization: body.token } });
    if (!payload.ok) die(`/api/dc/sidebar -> HTTP ${payload.status}`);
    return ((await payload.json()) as { guilds: Guild[] }).guilds;
  };
  const pin = async (guild: string, title: string) => {
    if (!/^\d{17,20}$/.test(guild)) die("guild must be a Discord snowflake id");
    const url_path = `${PREFIX}${guild}`;
    const existing = (await dashboards()).find((d) => d.url_path === url_path);
    if (!existing) {
      await ha.send({ type: "lovelace/dashboards/create", url_path, title, icon: "mdi:discord", show_in_sidebar: true, require_admin: false, mode: "storage" });
    } else if (existing.title !== title || !existing.show_in_sidebar) {
      await ha.send({ type: "lovelace/dashboards/update", dashboard_id: existing.id, title, show_in_sidebar: true });
    }
    await ha.send({ type: "lovelace/config/save", url_path, config: { strategy: { type: "iframe", url: frameUrl(guild) } } });
    const config = await ha.send<{ strategy?: { url?: string } }>({ type: "lovelace/config", url_path, force: true });
    if (config?.strategy?.url !== frameUrl(guild)) die(`${url_path}: iframe config did not persist`);
    console.log(`  ✓ ${existing ? "updated" : "pinned"}  ${url_path.padEnd(26)} ${title}`);
  };
  const setVisible = async (url_path: string, show: boolean) => {
    const d = (await dashboards()).find((x) => x.url_path === url_path) ?? die(`${url_path} is not a ${PREFIX}* dashboard`);
    const after = await ha.send<Dashboard>({ type: "lovelace/dashboards/update", dashboard_id: d.id, show_in_sidebar: show });
    if (after.show_in_sidebar !== show) die(`${url_path}: show_in_sidebar did not change`);
    console.log(`  ✓ ${show ? "shown" : "hidden"}  ${url_path}`);
  };

  switch (command) {
    case "list": {
      const rows = await dashboards();
      if (!rows.length) console.log(`  (no ${PREFIX}* dashboards yet — run: pin GUILD_ID TITLE, or sync)`);
      for (const d of rows) {
        const config = await ha.send<{ strategy?: { url?: string } }>({ type: "lovelace/config", url_path: d.url_path, force: true }).catch(() => null);
        console.log(`  ${d.show_in_sidebar ? "●" : "○"} ${d.url_path.padEnd(26)} ${d.title.padEnd(32)} ${config?.strategy?.url ?? "(no iframe config)"}`);
      }
      break;
    }
    case "servers": {
      for (const g of await servers()) console.log(`  ${g.hidden ? "hidden" : g.open ? "open  " : "closed"}  ${g.id}  ${String(g.imported_count).padStart(6)} msgs  ${g.name}`);
      break;
    }
    case "pin": {
      const [guild, ...title] = rest;
      if (!guild) die("pin needs GUILD_ID [TITLE]");
      let name = title.join(" ");
      if (!name) name = (await servers()).find((g) => g.id === guild)?.name ?? die(`guild ${guild} is not in the archive; give a TITLE explicitly`);
      await pin(guild, name);
      break;
    }
    case "sync": {
      const all = await servers(), have = await dashboards();
      for (const g of all) {
        const url_path = `${PREFIX}${g.id}`, d = have.find((x) => x.url_path === url_path);
        if (g.hidden) { if (d?.show_in_sidebar) await setVisible(url_path, false); else console.log(`  · skip    ${url_path.padEnd(26)} ${g.name} (hidden in the add-on)`); continue; }
        await pin(g.id, g.name);
      }
      for (const d of have) if (!RESERVED.has(d.url_path) && !all.some((g) => `${PREFIX}${g.id}` === d.url_path)) console.log(`  ! stale   ${d.url_path} is pinned but no longer in the archive — unpin it if you want`);
      break;
    }
    case "pin-timeline": {
      // The central timeline as its own HA sidebar entry: dc-timeline -> timeline.html
      const url_path = `${PREFIX}timeline`, title = rest.join(" ") || "Discord Timeline";
      const existing = (await dashboards()).find((d) => d.url_path === url_path);
      if (!existing) await ha.send({ type: "lovelace/dashboards/create", url_path, title, icon: "mdi:timeline-clock", show_in_sidebar: true, require_admin: false, mode: "storage" });
      else if (existing.title !== title || !existing.show_in_sidebar) await ha.send({ type: "lovelace/dashboards/update", dashboard_id: existing.id, title, show_in_sidebar: true });
      const url = `${entry}/timeline.html`;
      await ha.send({ type: "lovelace/config/save", url_path, config: { strategy: { type: "iframe", url } } });
      const config = await ha.send<{ strategy?: { url?: string } }>({ type: "lovelace/config", url_path, force: true });
      if (config?.strategy?.url !== url) die(`${url_path}: iframe config did not persist`);
      console.log(`  ✓ ${existing ? "updated" : "pinned"}  ${url_path.padEnd(26)} ${title}`);
      break;
    }
    case "hide": case "show": {
      const [url_path] = rest; if (!url_path) die(`${command} needs URL_PATH`);
      await setVisible(url_path, command === "show");
      break;
    }
    case "unpin": {
      const [url_path] = rest; if (!url_path) die("unpin needs URL_PATH");
      const d = (await dashboards()).find((x) => x.url_path === url_path) ?? die(`${url_path} is not a ${PREFIX}* dashboard`);
      await ha.send({ type: "lovelace/dashboards/delete", dashboard_id: d.id });
      if ((await dashboards()).some((x) => x.url_path === url_path)) die(`${url_path} still listed after delete`);
      console.log(`  ✓ unpinned ${url_path}`);
      break;
    }
    default: die(`unknown command ${command}; use list | servers | pin | pin-timeline | sync | hide | show | unpin`);
  }
  ha.close();
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
