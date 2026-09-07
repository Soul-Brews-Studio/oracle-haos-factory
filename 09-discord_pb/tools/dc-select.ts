#!/usr/bin/env bun
/**
 * Bulk channel selection for the archive, through real HA ingress.
 *
 *   bun tools/dc-select.ts --ip HOST --user U --pass-file F status
 *   bun tools/dc-select.ts ... select-all all            # every importable channel of every server
 *   bun tools/dc-select.ts ... select-all GUILD_ID_OR_NAME
 *   bun tools/dc-select.ts ... deselect-all GUILD_ID_OR_NAME
 *
 * Each channel goes through the add-on's own POST /api/dc/channels/{id}/select,
 * so the declared model (dc.config.yaml) and the checkbox table stay in step and
 * a backfill request is queued exactly as a click in the Channel model tab
 * would. Importable = text, announcement, and thread channels; the bot must be
 * able to read a channel for backfill to succeed — archives it cannot read are
 * skipped and reported by backfill, they do not stop the run.
 *
 * The credential is read from --pass-file only; it never appears in argv.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const need = (n: string) => flag(n) ?? die(`--${n} is required`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [command = "status", target = ""] = positional;
const SLUG = flag("slug") ?? "local_discord_pb";

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

type Channel = { id: string; kind: string; name: string; guild_id: string; guild: string; importable: boolean; selected: boolean; imported_count: number; discord_type: number };
type Guild = { id: string; name: string; hidden: boolean };

async function main() {
  const ha = await websocket(await accessToken());
  const info = await ha.sup<{ ingress_entry?: string; ingress?: boolean }>(`/addons/${SLUG}/info`);
  if (!info?.ingress || !info.ingress_entry) die(`${SLUG} has no ingress`);
  const entry = info.ingress_entry;
  const session = (await ha.sup<{ session?: string }>("/ingress/session", "post"))?.session ?? die("could not open an ingress session");
  const cookie = { Cookie: `ingress_session=${session}` };
  const auth = await fetch(`${base}${entry}/api/discord/admin-token`, { method: "POST", headers: cookie });
  const body = await auth.json() as { token?: string; error?: string };
  if (!auth.ok || !body.token) die(`add-on refused auto-login: ${body.error ?? auth.status}`);
  const H = { ...cookie, Authorization: body.token, "Content-Type": "application/json" };
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${entry}/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${json.error ?? ""}`);
    return json;
  };
  const sidebar = await api("api/dc/sidebar") as { guilds: Guild[]; channels: Channel[] };

  const resolveGuild = (value: string): Guild | null => {
    if (!value) return null;
    const byId = sidebar.guilds.find((g) => g.id === value);
    if (byId) return byId;
    const folded = value.toLowerCase();
    return sidebar.guilds.find((g) => g.name.toLowerCase() === folded) ?? sidebar.guilds.find((g) => g.name.toLowerCase().includes(folded)) ?? null;
  };

  if (command === "status") {
    for (const g of sidebar.guilds) {
      const rows = sidebar.channels.filter((c) => c.guild_id === g.id);
      const importable = rows.filter((c) => c.importable), selected = importable.filter((c) => c.selected);
      const msgs = rows.reduce((n, c) => n + (c.imported_count || 0), 0);
      console.log(`  ${g.id}  selected ${String(selected.length).padStart(3)}/${String(importable.length).padEnd(3)} importable  ${String(msgs).padStart(7)} msgs  ${g.hidden ? "(hidden) " : ""}${g.name}`);
    }
    const all = sidebar.channels.filter((c) => c.importable);
    console.log(`  total: selected ${all.filter((c) => c.selected).length} / ${all.length} importable`);
    ha.close(); return;
  }

  if (command !== "select-all" && command !== "deselect-all") die(`unknown command ${command}; use status | select-all all|GUILD | deselect-all GUILD`);
  const on = command === "select-all";
  let guilds: Guild[];
  if (target === "all") { if (!on) die("deselect-all needs a specific server"); guilds = sidebar.guilds; }
  else { const g = resolveGuild(target) ?? die(`unknown server: ${target || "(none)"}; give an id, a name, or "all"`); guilds = [g]; }

  let changed = 0, skipped = 0, failed = 0;
  for (const g of guilds) {
    const targets = sidebar.channels.filter((c) => c.guild_id === g.id && c.importable && c.selected !== on);
    const already = sidebar.channels.filter((c) => c.guild_id === g.id && c.importable && c.selected === on).length;
    console.log(`== ${g.name}: ${targets.length} to ${on ? "select" : "deselect"}, ${already} already`);
    for (const c of targets) {
      try {
        const r = await api(`api/dc/channels/${encodeURIComponent(c.id)}/select`, { method: "POST", body: JSON.stringify({ on }) }) as { selected?: boolean };
        if (r.selected === on) changed++; else { failed++; console.log(`  ! ${c.name} (${c.id}) did not change`); }
      } catch (e) { failed++; console.log(`  ! ${c.name} (${c.id}): ${(e as Error).message}`); }
      if ((changed + failed) % 25 === 0) console.log(`  … ${changed} changed, ${failed} failed so far`);
    }
    skipped += already;
  }
  const after = await api("api/dc/sidebar") as { channels: Channel[] };
  const now = after.channels.filter((c) => c.importable && c.selected).length, total = after.channels.filter((c) => c.importable).length;
  console.log(`✓ ${changed} changed, ${skipped} already, ${failed} failed — selected now ${now} / ${total} importable; backfill request queued`);
  ha.close();
  if (failed) process.exit(1);
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
