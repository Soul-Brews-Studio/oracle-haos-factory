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
const mapping_url = process.env.MAPPING_URL ?? "";

// `dbname` selects the field allowlist. It is NOT recoverable from MQTT — see
// the long comment above toReading() — so it is an OPTION, exactly as it is a
// per-container config literal in the upstream Telegraf deployment. Empty means
// "no allowlist resolved", which this add-on reports rather than papers over.
const dbname_opt = process.env.DBNAME ?? "";

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
  dropped: number;
  // Split so "the transform is running" can never be inferred from "messages are
  // flowing". Upstream, 100% of this add-on's default traffic is in the second
  // bucket, and a single counter would have hidden that.
  mapped: number;          // status docs an allowlist was actually applied to
  notApplicable: number;   // messages no allowlist can describe (see toReading)
}
const stats: Stats = {
  connected: false, connectedAt: null, received: 0, forwarded: 0,
  failed: 0, lastTopic: null, lastAt: null, lastError: null, dropped: 0,
  mapped: 0, notApplicable: 0,
};

const log = (m: string) => console.log(`[mz_forwarder] ${m}`);

// At ~90 messages/second a line per message is not a log, it is a firehose that
// costs disk and hides real events. Per-message detail lives in the sidebar and
// /api/readings; the log gets one summary line per interval.
let sinceSummary = { received: 0, forwarded: 0, dropped: 0, failed: 0 };
setInterval(() => {
  const s = sinceSummary;
  if (s.received === 0) return;             // silence is not worth a line
  log(`60s: received ${s.received} · forwarded ${s.forwarded} · dropped ${s.dropped} · failed ${s.failed}`);
  sinceSummary = { received: 0, forwarded: 0, dropped: 0, failed: 0 };
}, 60_000);

// Last N readings, in memory only. /data is the persisted path, but a live view
// does not need history to survive a restart and a growing file on a lab guest
// is a slow disk leak.
const RECENT_MAX = 200;

// Per-topic counters and a rate. "1828 messages" says the pipe is open; it does
// not say WHICH devices are reporting or whether one has gone quiet. Counting
// by device and by metric is what turns a firehose into an inventory.
const byDevice = new Map<string, { count: number; last: number }>();
const byMetric = new Map<string, number>();
// Sliding 60s window of arrival timestamps, for messages/second.
let arrivals: number[] = [];
function rate(): number {
  const cutoff = Date.now() - 60_000;
  arrivals = arrivals.filter((t) => t >= cutoff);
  return Math.round((arrivals.length / 60) * 10) / 10;
}
const recent: Reading[] = [];

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
 * The transform, ported from 00_mz_forwarder's Starlark `apply(metric)`.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THIS. The field allowlist is selected by
 * `metric.tags.get("dbname", ...)`, and `dbname` is a STATIC TAG Telegraf stamps
 * from its own config — 02-config/templates/telegraf_config.j2 renders
 *   [inputs.mqtt_consumer.tags]
 *     dbname = "{{ dbname }}"
 * from the `dbname:` line of each hand-written params YAML. It is in neither the
 * topic string nor the payload (the live status document's top-level keys are
 * d, heap, info, millis, nickname, rssi — no dbname), and nothing in that repo
 * derives it: `topic_parsing` appears zero times across the whole checkout.
 * A direct MQTT subscriber can never read it off the wire.
 *
 * It is ALSO not derivable from the topic, and one FloodBoy fact proves it:
 * 07-output/telegraf.d/5m/027_model_floodboy.yml.conf and
 * 07-output/telegraf.d/1s/020_floodboy.yml.conf subscribe to the SAME pattern,
 * `FloodBoy/+/status`, and stamp DIFFERENT dbnames (model_floodboy,
 * floodboydb_realtime). Both containers are live. Identical bytes, two answers,
 * decided only by which container is running. So dbname comes from THIS add-on's
 * own configuration — the `dbname` option — which is the same place Telegraf
 * gets it. There is no cleverer source and pretending otherwise is a guess.
 *
 * WHAT DOES AND DOES NOT GET A FIELD MAP. Every allowlist key is a FLATTENED
 * STATUS-DOCUMENT path — `d_radar_water_depth`, `d_battery_voltage`,
 * `d_rainfall_rainfall_mm` — i.e. Telegraf's json parser applied to the single
 * JSON document published on `<Model>/<nickname>/status`. The per-metric topics
 * this add-on sees by default,
 *   FloodBoy/FloodBoy045/sensor/water_level/state       -> 0.000
 *   FloodBoy/FloodBoy027/sensor/radar__raw_message/state -> REALWATERDEPTH=0.495m
 * are a different shape entirely: five levels deep, one scalar per message, and
 * NO config in the upstream repo subscribes to them. Their key space
 * (`water_level`, `radar__raw_message`) shares not one member with any allowlist.
 * Running them through the allowlist would drop 100% of fields on 100% of
 * messages while the counters still climbed — a transform that silently deletes
 * everything looks identical to a transform that works. So they are declared
 * NOT APPLICABLE, explicitly, and pass through untouched.
 *
 * Three behaviours are ported; the third is the one a naive port misses:
 *   1. FIELD ALLOWLIST. `db_field_mappings[dbname]` is a list of {key, as}.
 *      Listed fields are renamed; **everything else is dropped**. Whitelist,
 *      not rename table.
 *   2. IDENTITY. For a `/status` topic the nickname is the SECOND-TO-LAST topic
 *      segment, and `webid_map[nickname]` supplies the `webid` tag.
 *   3. DROP THE UNIDENTIFIABLE. If the nickname has no webid, the original
 *      returns None — the metric goes to NO output, not even InfluxDB. Sending
 *      an unidentifiable series downstream is worse than sending nothing.
 *
 * ONE DELIBERATE DEVIATION, stated rather than hidden: upstream, an unknown
 * dbname short-circuits at the TOP of apply() (`return metric` unchanged), so
 * the webid drop never runs for it. Here the webid gate runs regardless of
 * whether a field map resolved. Refusing to forward a series nobody can
 * attribute is a safety property; it should not switch off because an unrelated
 * option was left blank.
 *
 * NOT PORTED, on purpose: the range gates (water_depth > 20.0 -> rejected,
 * battery_voltage outside 0-30, air_height outside 0-40) that exist only in the
 * realtime container's forked 05-docker/starlark/output.star. That fork's
 * webid_map contains ZERO FloodBoy entries, so its own webid gate returns None
 * before any range check executes — the gates are dead code upstream. Copying
 * dead validation across and calling it parity would be the same lie as the
 * empty allowlist.
 *
 * Both maps are DATA, not configuration — hundreds of entries — so they are
 * fetched from `mapping_url` rather than pasted into options.
 */
interface Mapping {
  webid_map?: Record<string, { webid: number | string }>;
  field_map?: Record<string, Array<{ key: string; as: string }>>;
  // Optional, and only ever a DEFAULT for the dbname option — never an override.
  // The upstream generator already emits most of this as
  // 03-services/proxy-http-honojs/params/config.json (dbname -> telegraf.topics);
  // note that generator globs 02-config/params only, so `floodboydb_realtime`
  // is missing from it and has to be added by hand.
  topic_map?: Array<{ dbname: string; topics: string[] }>;
}
let mapping: Mapping = {};
let mappingLoaded = false;

async function loadMapping() {
  if (!mapping_url) return;
  try {
    const res = await fetch(mapping_url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { log(`mapping fetch: HTTP ${res.status}`); return; }
    mapping = (await res.json()) as Mapping;
    mappingLoaded = true;
    log(`mapping loaded: ${Object.keys(mapping.webid_map ?? {}).length} webids, ` +
        `${Object.keys(mapping.field_map ?? {}).length} field maps`);
    log(`dbname: ${describeDbnameSource()}`);
  } catch (e) {
    log(`mapping fetch failed: ${String((e as Error).message ?? e).slice(0, 120)}`);
  }
}

/** MQTT wildcard match. `#` is terminal and swallows the rest; `+` is one level. */
function topicMatches(pattern: string, t: string): boolean {
  const p = pattern.split("/"), s = t.split("/");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "#") return true;
    if (i >= s.length) return false;
    if (p[i] !== "+" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

const sameFieldList = (a?: Array<{ key: string; as: string }>, b?: Array<{ key: string; as: string }>) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Resolve dbname for one topic. The option wins outright — it is the faithful
 * equivalent of Telegraf's per-container tag. topic_map is only consulted when
 * the option is blank, and it REFUSES to pick when two dbnames match the same
 * topic with different allowlists. `Model-NH/+/status` is exactly that case
 * (model_n-nh keys 1_pm*, model_n-nh-wifi keys d_pm*); guessing there would
 * silently drop every field of whichever model guessed wrong. FloodBoy also
 * matches two dbnames, but their field lists are byte-identical, so either
 * answer is the same answer and the match is allowed to stand.
 */
function resolveDbname(t: string): string | null {
  if (dbname_opt) return dbname_opt;
  const hits = (mapping.topic_map ?? [])
    .filter((e) => e.topics.some((p) => topicMatches(p, t)))
    .map((e) => e.dbname);
  if (hits.length === 0) return null;
  const first = mapping.field_map?.[hits[0]!];
  if (hits.every((d) => sameFieldList(mapping.field_map?.[d], first))) return hits[0]!;
  return null;   // genuinely ambiguous — refuse rather than guess
}

function describeDbnameSource(): string {
  if (dbname_opt) return `"${dbname_opt}" (option)`;
  if (mapping.topic_map?.length) return "per-topic from mapping.topic_map";
  return "unset — no field allowlist will be applied";
}

/**
 * Telegraf's `data_format = "json"` flattens nested objects with `_`, which is
 * why the allowlist keys read `d_radar_water_depth` and not `d.radar.water_depth`.
 * Non-numeric leaves are dropped because that parser also discards them by
 * default — `info.ssid` and `nickname` never reach the Starlark as fields, so an
 * allowlist that kept them here would not be the same allowlist.
 */
function flattenNumeric(o: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (o === null || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flattenNumeric(v, key, out);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v ? 1 : 0;
  }
  return out;
}

interface Reading {
  topic: string;
  device: string | null;
  metric: string | null;
  value: number | null;
  raw: string | null;
  webid: string | null;
  dbname: string | null;
  /** Present only when an allowlist was applied. Absent is not the same as {}. */
  fields?: Record<string, number>;
  /** False says "no allowlist can describe this message", not "none was set". */
  field_map_applied: boolean;
  ts: string;
}

function toReading(t: string, payload: string): Reading | null {
  const parts = t.split("/");
  const value = Number(payload);
  const isStatus = t.includes("/status");

  const base: Reading = {
    topic: t,
    device: parts[1] ?? null,
    metric: parts.slice(2).join("/") || null,
    value: Number.isFinite(value) ? value : null,
    raw: Number.isFinite(value) ? null : payload,
    webid: null,
    dbname: null,
    field_map_applied: false,
    ts: new Date().toISOString(),
  };

  // Identity resolution applies to /status topics, as in the original.
  if (isStatus) {
    const nickname = parts[parts.length - 2] ?? "";
    const found = mapping.webid_map?.[nickname];
    if (found) base.webid = String(found.webid);
    else if (mappingLoaded) return null;   // unidentifiable: drop, do not forward
  }

  // Everything below is the field allowlist, and it is gated on `isStatus`
  // because the allowlist keys ARE flattened status-document paths. A
  // `sensor/<name>/state` message carries one scalar and no document; there is
  // nothing for an allowlist to select from and no honest way to fake one.
  if (!isStatus) { stats.notApplicable++; return base; }

  const dbname = resolveDbname(t);
  base.dbname = dbname;
  const allow = dbname ? mapping.field_map?.[dbname] : undefined;
  if (!allow) { stats.notApplicable++; return base; }

  let doc: unknown;
  try { doc = JSON.parse(payload); } catch { stats.notApplicable++; return base; }

  const flat = flattenNumeric(doc);
  const out: Record<string, number> = {};
  for (const { key, as } of allow) {
    // `{key: "topic", as: "topic"}` appears in every mapping and is inert
    // upstream too — `topic` is a Telegraf TAG, never a field, so the rename
    // loop never matches it. It falls out here for the same reason.
    const v = flat[key];
    if (v !== undefined) out[as] = v;
  }

  base.fields = out;
  base.field_map_applied = true;
  base.value = null;
  // The dashboard has one value column and a status document has no single
  // value; a compact summary keeps that row informative without a UI change.
  base.raw = Object.entries(out).map(([k, v]) => `${k}=${v}`).join(" ") || null;
  stats.mapped++;
  return base;
}

async function forward(reading: Reading) {
  // dry_run is the DEFAULT. A lab guest must not post to a production
  // endpoint because someone left a field blank.
  // No per-message log line here: see the 60s summary.
  if (dry_run || !api_endpoint) return;
  try {
    const res = await fetch(api_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reading),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) { stats.forwarded++; sinceSummary.forwarded++; }
    else { stats.failed++; stats.lastError = `HTTP ${res.status}`; }
  } catch (e) {
    stats.failed++; sinceSummary.failed++;
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
            sinceSummary.received++;
            arrivals.push(Date.now());
            const reading = toReading(t, payload);
            if (!reading) { stats.dropped++; sinceSummary.dropped++; break; }
            if (reading.device) {
              const d = byDevice.get(reading.device) ?? { count: 0, last: 0 };
              d.count++; d.last = Date.now(); byDevice.set(reading.device, d);
            }
            if (reading.metric) byMetric.set(reading.metric, (byMetric.get(reading.metric) ?? 0) + 1);
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
void loadMapping();
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
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:16px 0 6px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:14px}
</style>
<h1>MZ Forwarder <span class="mut" id="mode"></span></h1>
<div class="row">
  <div class="card"><div class="k">Broker</div><div class="v" id="broker">—</div></div>
  <div class="card"><div class="k">Received</div><div class="v" id="rx">0</div></div>
  <div class="card"><div class="k">Forwarded</div><div class="v" id="fw">0</div></div>
  <div class="card"><div class="k">Dropped</div><div class="v" id="dr">0</div></div>
  <div class="card"><div class="k">Mapped</div><div class="v" id="mp">0</div><div class="k" id="mpnote">field map</div></div>
  <div class="card"><div class="k">Rate</div><div class="v" id="rt">0</div><div class="k">msg/sec</div></div>
  <div class="card"><div class="k">Devices</div><div class="v" id="dv">0</div></div>
</div>
<div class="grid">
 <div>
  <h2>Devices</h2>
  <table><thead><tr><th>Device</th><th class="n">Msgs</th><th class="n">Quiet</th></tr></thead>
  <tbody id="devs"><tr><td colspan="3" class="mut">—</td></tr></tbody></table>
 </div>
 <div>
  <h2>Topics</h2>
  <table><thead><tr><th>Metric</th><th class="n">Msgs</th></tr></thead>
  <tbody id="mets"><tr><td colspan="2" class="mut">—</td></tr></tbody></table>
 </div>
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
    document.getElementById("dr").textContent = s.dropped ?? 0;
    document.getElementById("mp").textContent = s.mapped ?? 0;
    // A zero here with traffic flowing is the honest signal that no allowlist
    // describes this topic shape — it must never read as a silent success.
    document.getElementById("mpnote").textContent =
      (s.mapped ? "field map" : "not applicable (" + (s.notApplicable ?? 0) + ")");
    document.getElementById("rt").textContent = d.rate;
    document.getElementById("dv").textContent = d.devices.length;
    document.getElementById("devs").innerHTML = d.devices.slice(0,12).map(x =>
      "<tr><td>" + esc(x.name) + "</td><td class=n>" + x.count +
      "</td><td class='n mut'>" + (x.quietFor > 90 ? x.quietFor + "s" : "") + "</td></tr>").join("")
      || "<tr><td colspan=3 class=mut>none yet</td></tr>";
    document.getElementById("mets").innerHTML = d.metrics.map(x =>
      "<tr><td>" + esc(x.name) + "</td><td class=n>" + x.count + "</td></tr>").join("")
      || "<tr><td colspan=2 class=mut>none yet</td></tr>";
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
      const now = Date.now();
      const devices = [...byDevice.entries()]
        .map(([name, d]) => ({ name, count: d.count, quietFor: Math.round((now - d.last) / 1000) }))
        .sort((a, b) => b.count - a.count);
      const metrics = [...byMetric.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count).slice(0, 12);
      return Response.json({
        recent: recent.slice(0, 40), stats,
        rate: rate(), devices, metrics,
        mapping_loaded: mappingLoaded,
      });
    }

    if (request.method === "GET" && pathname === "/api/health") {
      // The scaffold echoes every option here. mqtt_pass is NOT among these:
      // a health endpoint that prints a credential is the same defect class as
      // an add-on `schema` call printing its own options, which leaked a key on
      // 2026-08-28. Report the endpoint's SHAPE, never its secrets.
      //
      // field_map_applicable is the field this whole patch exists to be able to
      // answer truthfully. `false` with traffic flowing means the allowlist does
      // not describe the topics arriving — not that the add-on is broken, and
      // not that the transform quietly succeeded.
      const dbname = dbname_opt || null;
      const allow = dbname ? mapping.field_map?.[dbname] : undefined;
      return Response.json({
        status: stats.connected ? "ok" : "degraded",
        slug: "mz_forwarder",
        broker: `${brokerHost}:${brokerPort}`,
        topic,
        dry_run: dry_run || !api_endpoint,
        api_endpoint_set: api_endpoint.length > 0,
        mapping_loaded: mappingLoaded,
        webids: Object.keys(mapping.webid_map ?? {}).length,
        dbname,
        dbname_source: describeDbnameSource(),
        // dbname can never come off the wire: it is a Telegraf static tag, and
        // the same FloodBoy/+/status topic carries two different values in two
        // live containers. Anything but "option"/"topic_map" would be invented.
        dbname_from_message: false,
        field_map_keys: Object.keys(mapping.field_map ?? {}).length,
        field_map_fields: allow?.length ?? 0,
        field_map_applicable: stats.mapped > 0,
        field_map_applied: stats.mapped,
        field_map_not_applicable: stats.notApplicable,
        ...stats,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});
log(`http listening on ${port}`);
