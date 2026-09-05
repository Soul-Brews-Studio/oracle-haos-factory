// FB Stream Ego — read-only HAOS add-on that mirrors the fb-stream-ego exporter.
// Polls EXPORTER_URL/api/snapshot, validates it, keeps the last good snapshot, and
// serves an Ingress UI plus /api/health and /api/snapshot. Message text leaves the
// container only on requests that arrived through Home Assistant Ingress.

export interface ExporterThread {
  threadId: string; name: string; preview: string; seenCount: number; firstSeen: string; lastSeen: string; messages: number;
}
export interface ExporterMessage {
  hash: string; threadId: string; thread: string; ts: string | null; sender: string | null; direction: string; text: string; images: number; seenAt: string;
}
export interface ExporterSnapshot {
  generatedAt: string;
  source: { name: string; host: string; database: string; schemaVersion: number };
  hubUp: boolean;
  latestSeenAt: string | null;
  counts: { threads: number; aliases: number; messages: number; returned: number } | null;
  threads: ExporterThread[];
  messages: ExporterMessage[];
  errors: string[];
}
export interface MonitorState { snapshot: ExporterSnapshot | null; fetchedAt: number | null; lastError: string | null }

export const SLUG = "fb_stream_ego";
export const VERSION = "0.1.1";
const port = Number(process.env.PORT ?? "8105");
// These reads are generated from the same definitions that produced config.yaml and run.sh.
const exporterUrl = (process.env.EXPORTER_URL ?? "http://a0d7b954-ssh:18795").replace(/\/$/, "");
const refreshSeconds = Math.max(2, Number.parseInt(process.env.REFRESH_SECONDS ?? "10", 10) || 10);
// Optional shared secret for the exporter relay; read once, sent as a header, never logged or served.
const exporterToken = process.env.EXPORTER_TOKEN?.trim() || null;
const staleAfterMs = refreshSeconds * 3_000;

export const state: MonitorState = { snapshot: null, fetchedAt: null, lastError: null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function isSnapshot(value: unknown): value is ExporterSnapshot {
  if (!isRecord(value) || !isRecord(value.source) || !Array.isArray(value.threads) || !Array.isArray(value.messages) || !Array.isArray(value.errors)) return false;
  if (typeof value.generatedAt !== "string" || typeof value.source.name !== "string" || typeof value.hubUp !== "boolean") return false;
  if (value.counts !== null && !(isRecord(value.counts) && typeof value.counts.messages === "number" && typeof value.counts.threads === "number")) return false;
  return value.threads.every((t) => isRecord(t) && typeof t.threadId === "string" && typeof t.name === "string")
    && value.messages.every((m) => isRecord(m) && typeof m.hash === "string" && typeof m.threadId === "string" && typeof m.text === "string" && typeof m.seenAt === "string");
}

export async function refreshSnapshot(target = exporterUrl, store = state): Promise<boolean> {
  try {
    const headers: Record<string, string> = exporterToken ? { authorization: `Bearer ${exporterToken}` } : {};
    const response = await fetch(`${target}/api/snapshot`, { signal: AbortSignal.timeout(5_000), headers });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`exporter HTTP ${response.status}${isRecord(payload) && Array.isArray(payload.errors) ? `: ${payload.errors.join("; ")}` : ""}`);
    if (!isSnapshot(payload)) throw new Error("exporter returned an invalid snapshot");
    if (payload.errors.length) throw new Error(`exporter errors: ${payload.errors.join("; ")}`);
    store.snapshot = payload; store.fetchedAt = Date.now(); store.lastError = null;
    return true;
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function freshness(store: MonitorState, now: number) {
  const ageMs = store.fetchedAt === null ? null : now - store.fetchedAt;
  return { ageMs, fresh: store.snapshot !== null && ageMs !== null && ageMs <= staleAfterMs };
}

export function health(store: MonitorState, now = Date.now()) {
  const { ageMs, fresh } = freshness(store, now);
  const s = store.snapshot;
  return {
    status: fresh ? "ok" : "unavailable",
    slug: SLUG, name: "FB Stream Ego", version: VERSION,
    exporterUrl, exporterTokenConfigured: exporterToken !== null, refreshSeconds, staleAfterSeconds: staleAfterMs / 1000,
    snapshotAgeSeconds: ageMs === null ? null : Math.round(ageMs / 100) / 10,
    source: s?.source ?? null, sourceGeneratedAt: s?.generatedAt ?? null, sourceHubUp: s?.hubUp ?? null, latestSeenAt: s?.latestSeenAt ?? null,
    counts: s?.counts ?? null,
    lastError: store.lastError,
  };
}

// Home Assistant's Ingress proxy adds X-Ingress-Path; a request without it came in on the
// published LAN port and must not carry message text.
export const viaIngress = (request: Request): boolean => request.headers.has("x-ingress-path");

const page = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FB Stream Ego</title><style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e6e6;--mute:#8b93a7;--in:#3b82f6;--out:#22c55e;--unk:#f59e0b;--accent:#a78bfa;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Sukhumvit Set","Noto Sans Thai",system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:16px 22px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0}
h1{font-size:16px;margin:0}h1 span{color:var(--mute);font-weight:400;font-size:12px;margin-left:8px}.stat{color:var(--mute)}.stat b{color:var(--fg);font-size:18px;margin-right:4px}
.live{display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;border:1px solid var(--line);font-size:12px;font-weight:600}.live i{width:9px;height:9px;border-radius:50%;background:var(--mute)}
.live.on i{background:var(--out);animation:pulse 1.6s infinite}.live.stale i{background:var(--unk)}.live.bad i{background:#ef4444}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
main{padding:18px 22px;display:grid;gap:24px}section h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:0 0 8px}
.tools{display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap}input,select{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{padding:7px 11px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{color:var(--mute);font-weight:500;font-size:12px;white-space:nowrap}
td.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute);white-space:nowrap}td.text{white-space:pre-wrap;max-width:520px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#0b0d12}.in{background:var(--in)}.out{background:var(--out)}.unknown{background:var(--unk)}
#error{color:#ff9b9b;padding:0 22px}.empty{color:var(--mute);padding:12px}footer{color:var(--mute);font-size:12px;padding:0 22px 22px}
</style></head><body>
<header><h1>FB Stream Ego <span id="src">connecting…</span></h1>
<div class="stat"><b id="c-threads">–</b>threads</div><div class="stat"><b id="c-messages">–</b>messages</div>
<span class="live" id="live"><i></i><span id="live-text">checking…</span></span></header>
<div id="error"></div>
<main>
<section><h2>Newest messages</h2><div class="tools"><select id="thread"><option value="">all threads</option></select><input id="q" placeholder="filter text / sender" size="28"></div>
<div class="wrap"><table><thead><tr><th>thread</th><th>ts</th><th>sender</th><th>dir</th><th>text</th><th>seen_at</th></tr></thead><tbody id="messages"></tbody></table></div></section>
<section><h2>Threads</h2><div class="wrap"><table><thead><tr><th>name</th><th>preview</th><th>msgs</th><th>seen</th><th>last_seen</th></tr></thead><tbody id="threads"></tbody></table></div></section>
</main>
<footer>read-only · source: fb-stream-ego LanceDB on m5 via the exporter · add-on ${VERSION} · refresh every ${refreshSeconds}s</footer>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const t=s=>esc(s).replace("T"," ").replace(/\\.\\d+\\+00:00$/,"Z");
const ago=(iso,now)=>{if(!iso)return null;const s=Math.max(0,(new Date(now)-new Date(iso))/1000);return s<60?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":s<86400?Math.round(s/3600)+"h":Math.round(s/86400)+"d"};
let snap=null;
function render(){
  if(!snap)return;const sel=document.getElementById("thread"),cur=sel.value;
  sel.innerHTML='<option value="">all threads</option>'+snap.threads.map(r=>'<option value="'+esc(r.threadId)+'">'+esc(r.name||r.threadId)+'</option>').join("");sel.value=cur;
  const q=document.getElementById("q").value.toLowerCase();
  const rows=snap.messages.filter(m=>(!cur||m.threadId===cur)&&(!q||(m.text||"").toLowerCase().includes(q)||(m.sender||"").toLowerCase().includes(q)));
  document.getElementById("messages").innerHTML=rows.length?rows.map(m=>'<tr><td>'+esc(m.thread)+'</td><td class="mono">'+esc(m.ts)+'</td><td>'+esc(m.sender)+'</td><td><span class="badge '+esc(m.direction)+'">'+esc(m.direction)+'</span></td><td class="text">'+esc(m.text)+'</td><td class="mono">'+t(m.seenAt)+'</td></tr>').join(""):'<tr><td colspan="6" class="empty">'+(snap.messages.length?"no match":"exporter returned no messages")+'</td></tr>';
  document.getElementById("threads").innerHTML=snap.threads.map(r=>'<tr><td>'+esc(r.name)+'</td><td class="text">'+esc(r.preview)+'</td><td class="mono">'+r.messages+'</td><td class="mono">'+r.seenCount+'</td><td class="mono">'+t(r.lastSeen)+'</td></tr>').join("");
}
async function load(){
  const el=document.getElementById("live"),tx=document.getElementById("live-text");
  try{
    const r=await fetch("api/snapshot",{cache:"no-store"});const p=await r.json();
    if(!r.ok){el.className="live bad";tx.textContent="unavailable · "+(p.lastError||p.error||("HTTP "+r.status));document.getElementById("error").textContent="";return}
    snap=p;render();
    document.getElementById("src").textContent=p.source.name+" @ "+p.source.host+" · "+p.source.database;
    document.getElementById("c-threads").textContent=p.counts?p.counts.threads:"–";document.getElementById("c-messages").textContent=p.counts?p.counts.messages:"–";
    const age=ago(p.latestSeenAt,p.generatedAt),ageS=p.latestSeenAt?(new Date(p.generatedAt)-new Date(p.latestSeenAt))/1000:Infinity;
    el.className="live"+(p.hubUp?(ageS<120?" on":" stale"):"");
    tx.textContent=(p.hubUp?"hub up on m5":"hub down on m5")+" · "+(age?"last row "+age+" ago":"no rows")+" · exporter "+ago(p.generatedAt,new Date().toISOString())+" ago";
    document.getElementById("error").textContent=(p.errors||[]).join(" · ");
  }catch(e){el.className="live bad";tx.textContent="unreachable";document.getElementById("error").textContent=String(e)}
}
document.getElementById("thread").onchange=render;document.getElementById("q").oninput=render;load();setInterval(load,${refreshSeconds * 1_000});
</script></body></html>`;

export function handleRequest(request: Request, store = state, now = Date.now()): Response {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  if (pathname === "/" || pathname.endsWith("/")) return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (pathname === "/api/health") {
    const payload = health(store, now);
    return Response.json(payload, { status: payload.status === "ok" ? 200 : 503 });
  }
  if (pathname === "/api/snapshot") {
    const { fresh } = freshness(store, now);
    if (!store.snapshot || !fresh) return Response.json({ error: store.lastError ?? "snapshot unavailable", ...health(store, now) }, { status: 503 });
    const s = store.snapshot;
    const ingress = viaIngress(request);
    const body = ingress ? { ...s, viaIngress: true }
      : { generatedAt: s.generatedAt, source: s.source, hubUp: s.hubUp, latestSeenAt: s.latestSeenAt, counts: s.counts, threads: s.threads.map((t) => ({ threadId: t.threadId, name: t.name, messages: t.messages, lastSeen: t.lastSeen })), messages: [], errors: s.errors, viaIngress: false, note: "message text is served only through Home Assistant Ingress" };
    return Response.json({ status: "ok", ...body });
  }
  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  await refreshSnapshot();
  setInterval(() => { void refreshSnapshot(); }, refreshSeconds * 1_000);
  Bun.serve({ hostname: "0.0.0.0", port, fetch: (request) => handleRequest(request) });
  console.log(`FB Stream Ego ${VERSION} on :${port}; exporter ${exporterUrl}; refresh ${refreshSeconds}s; first fetch ${state.snapshot ? "ok" : `failed: ${state.lastError}`}`);
}
