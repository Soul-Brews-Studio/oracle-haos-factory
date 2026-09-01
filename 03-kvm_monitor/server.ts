export interface GuestSnapshot {
  name: string;
  state: string;
  memoryKiB: { actual?: number; rss?: number; unused?: number };
  interfaces: Array<{ name: string; mac: string; source: string; address?: string }>;
  disks: Array<{ target: string; source: string }>;
}

export interface KvmSnapshot {
  generatedAt: string;
  host: {
    name: string;
    load: number[];
    memoryKiB: { total: number; available: number };
    diskBytes: { total: number; free: number };
  };
  guests: GuestSnapshot[];
  errors: string[];
}

export interface MonitorState {
  snapshot: KvmSnapshot | null;
  fetchedAt: number | null;
  lastError: string | null;
}

const port = Number(process.env.PORT ?? "8102");
const exporterUrl = (process.env.EXPORTER_URL ?? "http://192.168.122.1:9108").replace(/\/$/, "");
const refreshSeconds = Math.max(2, Number.parseInt(process.env.REFRESH_SECONDS ?? "10", 10) || 10);
const staleAfterMs = refreshSeconds * 3_000;

export const state: MonitorState = { snapshot: null, fetchedAt: null, lastError: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSnapshot(value: unknown): value is KvmSnapshot {
  if (!isRecord(value) || !isRecord(value.host) || !Array.isArray(value.guests)) return false;
  return typeof value.generatedAt === "string"
    && typeof value.host.name === "string"
    && Array.isArray(value.host.load)
    && isRecord(value.host.memoryKiB)
    && isRecord(value.host.diskBytes)
    && value.guests.every((guest) => isRecord(guest) && typeof guest.name === "string" && typeof guest.state === "string");
}

export async function refreshSnapshot(target = exporterUrl, store = state): Promise<boolean> {
  try {
    const response = await fetch(`${target}/api/snapshot`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`exporter HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isSnapshot(payload)) throw new Error("exporter returned an invalid snapshot");
    store.snapshot = payload;
    store.fetchedAt = Date.now();
    store.lastError = null;
    return true;
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function health(store: MonitorState, now = Date.now()) {
  const ageMs = store.fetchedAt === null ? null : now - store.fetchedAt;
  const fresh = store.snapshot !== null && ageMs !== null && ageMs <= staleAfterMs;
  return {
    status: fresh ? "ok" : "unavailable",
    slug: "kvm_monitor",
    version: "0.1.1",
    exporterUrl,
    refreshSeconds,
    snapshotAgeSeconds: ageMs === null ? null : Math.round(ageMs / 100) / 10,
    guests: store.snapshot?.guests.length ?? 0,
    lastError: store.lastError,
  };
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KVM Monitor</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b1118;color:#e8f0f7}
body{margin:0;padding:24px;background:radial-gradient(circle at top right,#13354a 0,#0b1118 38%);min-height:100vh}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
h1{margin:0;font-size:28px}.sub{color:#8ca3b7;margin-top:6px}.badge{padding:7px 11px;border-radius:999px;background:#203243;color:#a9c2d7}
.ok{color:#67e8a5}.bad{color:#ff8c8c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.card{background:#111c27;border:1px solid #263849;border-radius:14px;padding:16px;box-shadow:0 10px 30px #0004}
.name{font-size:18px;font-weight:700}.state{margin-top:6px;text-transform:capitalize}.metric{display:flex;justify-content:space-between;margin-top:9px;color:#aec0cf}.metric b{color:#f0f6fa}
#error{margin:14px 0;color:#ff9b9b}.empty{color:#8ca3b7}</style></head>
<body><header><div><h1>KVM Monitor</h1><div class="sub" id="host">Loading kvmbox…</div></div><div class="badge" id="freshness">Connecting</div></header>
<div id="error"></div><main class="grid" id="guests"></main>
<script>
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const mib=(k)=>k==null?"—":(k/1024).toFixed(0)+" MiB";
async function render(){
  try{
    const r=await fetch("api/snapshot",{cache:"no-store"}); const p=await r.json(); if(!r.ok)throw new Error(p.error||("HTTP "+r.status));
    document.getElementById("host").textContent=p.host.name+" · load "+p.host.load.join(" / ");
    document.getElementById("freshness").textContent="Live · "+new Date(p.generatedAt).toLocaleTimeString();
    document.getElementById("freshness").className="badge ok";
    document.getElementById("error").textContent=(p.errors||[]).join(" · ");
    document.getElementById("guests").innerHTML=(p.guests||[]).map(g=>'<section class="card"><div class="name">'+esc(g.name)+'</div><div class="state '+(g.state==="running"?"ok":"")+'">'+esc(g.state)+'</div><div class="metric"><span>Allocated</span><b>'+mib(g.memoryKiB.actual)+'</b></div><div class="metric"><span>Host RSS</span><b>'+mib(g.memoryKiB.rss)+'</b></div><div class="metric"><span>Address</span><b>'+esc((g.interfaces||[]).map(i=>i.address).filter(Boolean).join(", ")||"—")+'</b></div></section>').join("")||'<div class="empty">No guests returned.</div>';
  }catch(e){document.getElementById("freshness").textContent="Unavailable";document.getElementById("freshness").className="badge bad";document.getElementById("error").textContent=String(e)}
}
render();setInterval(render,${refreshSeconds * 1_000});
</script></body></html>`;

export function handleRequest(request: Request, store = state, now = Date.now()): Response {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (pathname === "/" || pathname.endsWith("/")) {
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/api/health") {
    const payload = health(store, now);
    return Response.json(payload, { status: payload.status === "ok" ? 200 : 503 });
  }
  if (pathname === "/api/snapshot") {
    if (!store.snapshot || store.fetchedAt === null || now - store.fetchedAt > staleAfterMs) {
      return Response.json({ error: store.lastError ?? "snapshot unavailable", ...health(store, now) }, { status: 503 });
    }
    return Response.json(store.snapshot);
  }
  return new Response("Not found", { status: 404 });
}

if (import.meta.main && process.env.NODE_ENV !== "test") {
  await refreshSnapshot();
  setInterval(() => void refreshSnapshot(), refreshSeconds * 1_000);
  Bun.serve({ hostname: "0.0.0.0", port, fetch: (request) => handleRequest(request) });
  console.log(`KVM Monitor listening on ${port}; exporter ${exporterUrl}`);
}
