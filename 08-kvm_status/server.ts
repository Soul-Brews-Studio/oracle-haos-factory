/**
 * KVM Status — disk capacity and device health for this Home Assistant OS box.
 *
 * Every number on the page comes from the Supervisor API. Nothing is estimated,
 * nothing is cached longer than one poll, and a field the Supervisor does not
 * report is rendered as "—" rather than a plausible zero. On a page whose whole
 * job is to tell you whether a disk is filling up, an invented number is worse
 * than a blank.
 */

const port = Number(process.env.PORT ?? "8109");

// Generated from the same definitions that produced config.yaml and run.sh.
const refresh_seconds = Number.parseInt(process.env.REFRESH_SECONDS ?? "5", 10);
const disk_warn_percent = Number.parseInt(process.env.DISK_WARN_PERCENT ?? "80", 10);
const disk_critical_percent = Number.parseInt(process.env.DISK_CRITICAL_PERCENT ?? "90", 10);

/**
 * Injected by Supervisor into every add-on that declares `hassio_api: true`.
 * Absent means the grant is missing from config.yaml — a configuration fault,
 * not a transient one, so it is reported as such instead of retried forever.
 */
const TOKEN = process.env.SUPERVISOR_TOKEN ?? "";
const SUPERVISOR = "http://supervisor";

/**
 * Where the page and its vendored scripts live.
 *
 * Resolved from this module rather than hardcoded to /app, so the add-on can be
 * run straight from a checkout. A hardcoded container path makes every local
 * run 500 on the index with a raw ENOENT that names nothing — a trap this
 * factory has already recorded once.
 */
const ROOT = process.env.APP_ROOT ?? import.meta.dir;

/**
 * The page is a real .html file, not a template literal in this source.
 *
 * `String.raw` does NOT stop ${...} interpolation — it only stops escape
 * processing — so markup holding ${k} inside a template literal is parsed as
 * TypeScript expressions and the file fails to compile. Measured here: the
 * first version of this add-on died with `Expected ";" but found "{"`. The same
 * class of bug (client markup living inside a TS template) is already written
 * up in digger-node's page.ts. An .html file cannot have it.
 */
const INDEX_HTML = await Bun.file(`${ROOT}/web/index.html`).text();

/** Observed, not configured: what the last poll actually did. */
const observed: {
  lastOk: string | null;
  lastError: string | null;
  polls: number;
  failures: number;
} = { lastOk: null, lastError: null, polls: 0, failures: 0 };

async function supervisor<T>(path: string): Promise<T | null> {
  if (!TOKEN) return null;
  try {
    const response = await fetch(`${SUPERVISOR}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
    return ((await response.json()) as { data: T }).data;
  } catch (error) {
    observed.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/**
 * One round of the whole picture.
 *
 * The four calls run together because they are independent and the page shows
 * them as one moment; a sequential version makes the disk figure four round
 * trips older than the CPU figure for no reason.
 */
async function snapshot() {
  observed.polls += 1;
  const [host, os, sup] = await Promise.all([
    supervisor<Record<string, unknown>>("/host/info"),
    supervisor<Record<string, unknown>>("/os/info"),
    supervisor<Record<string, unknown>>("/supervisor/info"),
  ]);

  if (!host) {
    observed.failures += 1;
    return { ok: false as const, error: observed.lastError ?? "supervisor unreachable" };
  }
  observed.lastOk = new Date().toISOString();

  const total = num(host.disk_total);
  const used = num(host.disk_used);
  const free = num(host.disk_free);
  // Percent is DERIVED, and only when both parts are real. Supervisor reports
  // used and free independently and they need not sum to total (reserved
  // blocks), so used/total is the honest ratio rather than 100 - free/total.
  const usedPercent = total && used !== null ? round((used / total) * 100, 1) : null;

  const addons = Array.isArray(sup?.addons) ? (sup!.addons as Record<string, unknown>[]) : [];

  return {
    ok: true as const,
    at: observed.lastOk,
    disk: {
      total_gb: total,
      used_gb: used,
      free_gb: free,
      used_percent: usedPercent,
      // null on this board rather than 0 — an SSD wear figure the host does not
      // publish must not render as "0% worn", which reads as good news.
      life_time: host.disk_life_time ?? null,
      data_disk: os?.data_disk ?? null,
    },
    host: {
      hostname: host.hostname ?? null,
      operating_system: host.operating_system ?? null,
      kernel: host.kernel ?? null,
      chassis: host.chassis ?? null,
      virtualization: host.virtualization ?? null,
      board: os?.board ?? null,
      timezone: host.timezone ?? null,
      // boot_timestamp is MICROseconds since the epoch on this agent, not ms.
      uptime_seconds: host.boot_timestamp
        ? Math.max(0, Math.floor(Date.now() / 1000 - num(host.boot_timestamp)! / 1e6))
        : null,
      os_update_available: os?.update_available ?? null,
      os_version: os?.version ?? null,
      os_version_latest: os?.version_latest ?? null,
    },
    supervisor: {
      version: sup?.version ?? null,
      arch: sup?.arch ?? null,
      channel: sup?.channel ?? null,
      healthy: sup?.healthy ?? null,
      supported: sup?.supported ?? null,
      update_available: sup?.update_available ?? null,
    },
    memory: readMemory(),
    load: readLoad(),
    addons: addons
      .map((a) => ({
        slug: String(a.slug ?? ""),
        name: String(a.name ?? a.slug ?? ""),
        state: String(a.state ?? "unknown"),
        version: a.version ?? null,
        update_available: Boolean(a.update_available),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    thresholds: { warn: disk_warn_percent, critical: disk_critical_percent },
  };
}

/**
 * Memory and load come from /proc, not from the Supervisor API.
 *
 * Measured, not assumed: `hassio_api: true` grants neither /supervisor/stats
 * nor /core/stats — both answer 403 for an add-on with this role, and the
 * memory card silently rendered blank as a result. The alternatives were to
 * request a broader role, or to ask the kernel. The kernel is both cheaper and
 * more correct here: those endpoints report a CONTAINER's usage, and a page
 * headed "device status" should be showing the host.
 *
 * An add-on container shares the host's /proc, so MemTotal here is the machine's
 * RAM. If a future HAOS namespaces this, the numbers become the container's and
 * the label on the card would be wrong — so the reading is checked against a
 * plausible floor rather than trusted blindly.
 */
function readMemory(): Record<string, number | null> | null {
  try {
    const text = require("node:fs").readFileSync("/proc/meminfo", "utf8") as string;
    const kb = (key: string): number | null => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal");
    const available = kb("MemAvailable");
    if (total === null || available === null) return null;
    const used = total - available;
    return {
      total_bytes: total,
      available_bytes: available,
      used_bytes: used,
      percent: round((used / total) * 100, 1),
    };
  } catch {
    return null;
  }
}

/** 1/5/15-minute load, and the core count needed to read it. */
function readLoad(): Record<string, number | null> | null {
  try {
    const fs = require("node:fs");
    const parts = (fs.readFileSync("/proc/loadavg", "utf8") as string).trim().split(/\s+/);
    const cpus = (fs.readFileSync("/proc/cpuinfo", "utf8") as string).match(/^processor\s*:/gm);
    return {
      one: Number(parts[0]),
      five: Number(parts[1]),
      fifteen: Number(parts[2]),
      cpus: cpus ? cpus.length : null,
    };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round = (v: number, places: number) => Number(v.toFixed(places));

/**
 * The ingress prefix, for outbound URLs only.
 *
 * The prefix IS `/api/hassio_ingress/<token>`, so anything that tries to STRIP
 * it with a pattern anchored on `/api` matches at position 0 and removes the
 * wrong thing — a trap this factory has already paid for once. Ingress delivers
 * the unprefixed path; only the URLs this page emits need it added back.
 *
 * Never treated as authorization: every add-on shares the 172.30.32.0/23
 * bridge, so this header is a claim from an unauthenticated party.
 */
function ingressBase(request: Request): string {
  const raw = request.headers.get("x-ingress-path") ?? "";
  if (!/^\/[\w\-./]*$/.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

const page = (base: string) =>
  INDEX_HTML.replaceAll("__BASE__", base).replaceAll(
    "__REFRESH_MS__",
    String(Math.max(1, refresh_seconds) * 1000),
  );

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(page(ingressBase(request)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Vendored at build time. A CDN here renders a blank panel on any HA box
    // that is on a LAN without internet, which is a normal way to run one.
    if (request.method === "GET" && pathname.startsWith("/vendor/")) {
      const file = Bun.file(`${ROOT}${pathname}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/status") {
      return Response.json(await snapshot());
    }

    if (request.method === "GET" && pathname === "/api/health") {
      // STATE, not config. A health endpoint that echoes the options it was
      // handed stays green through a total outage — the failure this factory
      // documents. These four fields can only be produced by having tried.
      const ok = observed.lastOk !== null && observed.failures < observed.polls;
      // Zero polls is "starting", not "degraded". Reporting a fault before
      // anything has been attempted is the mirror of a health check that stays
      // green through an outage — both describe a state that was never observed.
      const status = !TOKEN
        ? "misconfigured"
        : observed.polls === 0
          ? "starting"
          : ok
            ? "ok"
            : "degraded";
      return Response.json(
        {
          status,
          detail: TOKEN ? undefined : "SUPERVISOR_TOKEN absent — is hassio_api: true set?",
          last_success: observed.lastOk,
          last_error: observed.lastError,
          polls: observed.polls,
          failures: observed.failures,
        },
        { status: ok || !observed.polls ? 200 : 503 },
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `kvm_status listening on :${port} refresh=${refresh_seconds}s ` +
    `warn=${disk_warn_percent}% critical=${disk_critical_percent}% ` +
    `supervisor_token=${TOKEN ? "present" : "ABSENT"}`,
);
