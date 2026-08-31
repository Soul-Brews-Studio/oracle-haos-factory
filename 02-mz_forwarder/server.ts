// MQTT -> HTTP forwarder, in the shape of laris-co/00_mz_forwarder's last hop.
//
// That pipeline is sensors -> Mosquitto -> ~20 Telegraf containers (Starlark)
// -> Flask -> CCDC. An add-on is ONE container, so this is deliberately the
// forwarder hop only: subscribe, transform, POST. The broker stays the guest's
// own core_mosquitto add-on rather than a second broker shipped inside this one.
//
// No dependencies: the Dockerfile copies server.ts alone and installs nothing,
// so MQTT 3.1.1 is spoken directly over a socket. That keeps the image identical
// to the scaffold's and the build reproducible.

const port = Number(process.env.PORT ?? "8100");
const mqtt_host = process.env.MQTT_HOST ?? "mqtt.laris.co";
const mqtt_user = process.env.MQTT_USER ?? "nat";
const mqtt_pass = process.env.MQTT_PASS ?? "changeme";
const topic = process.env.TOPIC ?? "FloodBoy/#";
const api_endpoint = process.env.API_ENDPOINT ?? "";
const dry_run = (process.env.DRY_RUN ?? "true") === "true";

// The broker's add-on hostname uses a HYPHEN: core_mosquitto is the SLUG, and
// Home Assistant converts underscores to hyphens for container hostnames. The
// slug form does not resolve, and the failure reads as a broker fault.
const brokerHost = mqtt_host.replace(/_/g, "-");
const brokerPort = 1883;

interface Stats {
  connected: boolean;
  connectedAt: string | null;
  received: number;
  forwarded: number;
  failed: number;
  lastTopic: string | null;
  lastAt: string | null;
  lastError: string | null;
}
const stats: Stats = {
  connected: false, connectedAt: null, received: 0, forwarded: 0,
  failed: 0, lastTopic: null, lastAt: null, lastError: null,
};

const log = (m: string) => console.log(`[mz_forwarder] ${m}`);

// Last N readings, in memory only. /data is the persisted path, but a live view
// does not need history to survive a restart and a growing file on a lab guest
// is a slow disk leak.
const RECENT_MAX = 200;
const recent: Array<{ topic: string; device: string | null; metric: string | null; value: number | null; raw: string | null; ts: string }> = [];

// ── minimal MQTT 3.1.1 ──────────────────────────────────────────────────────
const str = (s: string): number[] => {
  const b = new TextEncoder().encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const remainingLength = (n: number): number[] => {
  const out: number[] = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return out;
};
const packet = (type: number, body: number[]): Uint8Array =>
  new Uint8Array([type, ...remainingLength(body.length), ...body]);

function connectPacket(): Uint8Array {
  // clean session + username + password, keepalive 60s
  const flags = 0xC2;
  return packet(0x10, [
    ...str("MQTT"), 4, flags, 0, 60,
    ...str(`mz-forwarder-${Math.random().toString(16).slice(2, 8)}`),
    ...str(mqtt_user), ...str(mqtt_pass),
  ]);
}
const subscribePacket = (t: string): Uint8Array =>
  packet(0x82, [0, 1, ...str(t), 0]); // packet id 1, QoS 0

/** Decode a PUBLISH frame's topic and payload. QoS 0 only — no packet id. */
function decodePublish(buf: Uint8Array, start: number, len: number) {
  const topicLen = (buf[start]! << 8) | buf[start + 1]!;
  const t = new TextDecoder().decode(buf.subarray(start + 2, start + 2 + topicLen));
  const payload = new TextDecoder().decode(buf.subarray(start + 2 + topicLen, start + len));
  return { topic: t, payload };
}

/**
 * The transform. mz_forwarder does this in Starlark inside Telegraf; here it is
 * one function so the shape is visible and testable. Topic segments become
 * fields, which is what the CCDC endpoints expect per device model.
 */
function toReading(t: string, payload: string) {
  const parts = t.split("/");
  const value = Number(payload);
  return {
    topic: t,
    device: parts[1] ?? null,
    metric: parts.slice(2).join("/") || null,
    value: Number.isFinite(value) ? value : null,
    raw: Number.isFinite(value) ? null : payload,
    ts: new Date().toISOString(),
  };
}

async function forward(reading: ReturnType<typeof toReading>) {
  // dry_run is the DEFAULT. A lab guest must not post to a production
  // endpoint because someone left a field blank.
  if (dry_run || !api_endpoint) {
    log(`dry-run ${reading.topic} = ${reading.value ?? reading.raw}`);
    return;
  }
  try {
    const res = await fetch(api_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reading),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) { stats.forwarded++; }
    else { stats.failed++; stats.lastError = `HTTP ${res.status}`; }
  } catch (e) {
    stats.failed++;
    stats.lastError = String((e as Error).message ?? e).slice(0, 200);
  }
}

let ping: ReturnType<typeof setInterval> | null = null;

function connect() {
  let buf = new Uint8Array(0);
  Bun.connect({
    hostname: brokerHost,
    port: brokerPort,
    socket: {
      open(socket) { log(`connecting to ${brokerHost}:${brokerPort}`); socket.write(connectPacket()); },
      data(socket, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf); merged.set(chunk, buf.length); buf = merged;

        // Frames arrive coalesced and split; drain whatever is complete.
        for (;;) {
          if (buf.length < 2) return;
          let mult = 1, len = 0, i = 1, digit = 0;
          do {
            if (i >= buf.length) return;              // length not fully arrived
            digit = buf[i]!; len += (digit & 127) * mult; mult *= 128; i++;
          } while ((digit & 128) !== 0);
          const total = i + len;
          if (buf.length < total) return;             // body not fully arrived

          const type = buf[0]! >> 4;
          if (type === 2) {                            // CONNACK
            const code = buf[3];
            if (code === 0) {
              stats.connected = true;
              stats.connectedAt = new Date().toISOString();
              log(`connected; subscribing to ${topic}`);
              socket.write(subscribePacket(topic));
              // Keepalive is declared as 60s in CONNECT. A client that never
              // pings is disconnected by the broker at 1.5x that, and the
              // symptom is a connection that "randomly drops" every ~90s.
              if (ping) clearInterval(ping);
              ping = setInterval(() => socket.write(new Uint8Array([0xC0, 0x00])), 30_000);
            } else {
              stats.lastError = `CONNACK refused, code ${code}`;
              log(stats.lastError);
            }
          } else if (type === 3) {                     // PUBLISH
            const { topic: t, payload } = decodePublish(buf, i, len);
            stats.received++; stats.lastTopic = t; stats.lastAt = new Date().toISOString();
            const reading = toReading(t, payload);
            recent.unshift(reading);
            if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
            void forward(reading);
          } else if (type === 9) {                     // SUBACK
            log("subscribed");
          }
          buf = buf.slice(total);
        }
      },
      close() {
        stats.connected = false;
        if (ping) { clearInterval(ping); ping = null; }
        log("broker connection closed; retrying in 5s");
        setTimeout(connect, 5000);
      },
      error(_s, e) {
        stats.connected = false;
        stats.lastError = String(e?.message ?? e).slice(0, 200);
        log(`socket error: ${stats.lastError}`);
      },
    },
  }).catch((e) => {
    stats.lastError = String(e?.message ?? e).slice(0, 200);
    log(`connect failed: ${stats.lastError}; retrying in 5s`);
    setTimeout(connect, 5000);
  });
}
connect();

const PAGE = `<!doctype html><meta charset="utf-8"><title>MZ Forwarder</title>
<style>
 :root{color-scheme:light dark;--bg:#f6f7f9;--fg:#16181d;--mut:#6b7280;--card:#fff;--line:#e5e7eb;--ok:#15803d;--bad:#b91c1c}
 @media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ec;--mut:#9aa3af;--card:#171a21;--line:#262b34;--ok:#4ade80;--bad:#f87171}}
 body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
 h1{font-size:16px;margin:0 0 12px}
 .row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:110px}
 .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .v{font-size:20px;font-variant-numeric:tabular-nums}
 .ok{color:var(--ok)}.bad{color:var(--bad)}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
 th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase}
 tr:last-child td{border-bottom:0}
 td.n{text-align:right}
 .mut{color:var(--mut)}
</style>
<h1>MZ Forwarder <span class="mut" id="mode"></span></h1>
<div class="row">
  <div class="card"><div class="k">Broker</div><div class="v" id="broker">—</div></div>
  <div class="card"><div class="k">Received</div><div class="v" id="rx">0</div></div>
  <div class="card"><div class="k">Forwarded</div><div class="v" id="fw">0</div></div>
  <div class="card"><div class="k">Failed</div><div class="v" id="fa">0</div></div>
</div>
<table><thead><tr><th>Time</th><th>Device</th><th>Metric</th><th class="n">Value</th></tr></thead>
<tbody id="rows"><tr><td colspan="4" class="mut">waiting for messages…</td></tr></tbody></table>
<script>
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function tick(){
  try{
    // Relative URL: ingress serves this page under a path prefix.
    const r = await fetch("api/readings"); const d = await r.json();
    const s = d.stats;
    document.getElementById("broker").textContent = s.connected ? "up" : "down";
    document.getElementById("broker").className = "v " + (s.connected ? "ok" : "bad");
    document.getElementById("rx").textContent = s.received;
    document.getElementById("fw").textContent = s.forwarded;
    document.getElementById("fa").textContent = s.failed;
    document.getElementById("mode").textContent = s.lastError ? "— " + s.lastError : "";
    const rows = d.recent.map(x =>
      "<tr><td class=mut>" + esc(x.ts.slice(11,19)) + "</td><td>" + esc(x.device) +
      "</td><td class=mut>" + esc(x.metric) + "</td><td class=n>" +
      esc(x.value ?? x.raw) + "</td></tr>").join("");
    document.getElementById("rows").innerHTML = rows ||
      "<tr><td colspan=4 class=mut>connected, no messages yet</td></tr>";
  }catch(e){ document.getElementById("mode").textContent = "— page cannot reach the add-on"; }
}
tick(); setInterval(tick, 2000);
</script>`;

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      // Served as the ingress panel. Ingress mounts the add-on under a path
      // prefix, so every URL here must be RELATIVE — a leading slash escapes
      // the prefix and 404s inside the Home Assistant frame.
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "GET" && pathname === "/api/readings") {
      return Response.json({ recent: recent.slice(0, 60), stats });
    }

    if (request.method === "GET" && pathname === "/api/health") {
      // The scaffold echoes every option here. mqtt_pass is NOT among these:
      // a health endpoint that prints a credential is the same defect class as
      // an add-on `schema` call printing its own options, which leaked a key on
      // 2026-08-28. Report the endpoint's SHAPE, never its secrets.
      return Response.json({
        status: stats.connected ? "ok" : "degraded",
        slug: "mz_forwarder",
        broker: `${brokerHost}:${brokerPort}`,
        topic,
        dry_run: dry_run || !api_endpoint,
        api_endpoint_set: api_endpoint.length > 0,
        ...stats,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});
log(`http listening on ${port}`);
