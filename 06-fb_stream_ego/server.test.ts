import { describe, expect, test } from "bun:test";
import { handleRequest, isSnapshot, viaIngress, type ExporterSnapshot, type MonitorState } from "./server";

const snapshot: ExporterSnapshot = {
  generatedAt: "2026-09-02T03:00:00+00:00",
  source: { name: "fb-stream-ego", host: "m5", database: "fb-stream-ego.lancedb", schemaVersion: 1 },
  hubUp: true,
  latestSeenAt: "2026-09-02T02:59:50+00:00",
  counts: { threads: 2, aliases: 2, messages: 3, returned: 1 },
  threads: [{ threadId: "101", name: "Alpha", preview: "hi", seenCount: 3, firstSeen: "a", lastSeen: "b", messages: 1 }],
  messages: [{ hash: "abcd", threadId: "101", thread: "Alpha", ts: "Monday 6:45pm", sender: "You", direction: "out", text: "<b>secret</b>", images: 0, seenAt: "2026-09-02T02:59:50+00:00" }],
  errors: [],
};
const fresh = (): MonitorState => ({ snapshot, fetchedAt: 10_000, lastError: null });

describe("fb stream ego add-on", () => {
  test("accepts a valid exporter snapshot", () => expect(isSnapshot(snapshot)).toBe(true));
  test("rejects malformed exporter data", () => {
    expect(isSnapshot({ generatedAt: "now" })).toBe(false);
    expect(isSnapshot({ ...snapshot, messages: [{ hash: 1 }] })).toBe(false);
  });

  test("health carries identity, version, freshness and counts", async () => {
    const response = handleRequest(new Request("http://x/api/health"), fresh(), 12_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", slug: "fb_stream_ego", version: "0.1.1", snapshotAgeSeconds: 2, exporterTokenConfigured: false, counts: { messages: 3 }, source: { name: "fb-stream-ego" } });
  });

  test("missing and stale snapshots are 503, never zeros", async () => {
    const missing = handleRequest(new Request("http://x/api/health"), { snapshot: null, fetchedAt: null, lastError: "offline" }, 10_000);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ status: "unavailable", lastError: "offline", counts: null });
    const stale = handleRequest(new Request("http://x/api/snapshot"), { snapshot, fetchedAt: 0, lastError: null }, 60_000);
    expect(stale.status).toBe(503);
  });

  test("message text only through Ingress", async () => {
    const direct = await handleRequest(new Request("http://x/api/snapshot"), fresh(), 11_000).json();
    expect(direct.viaIngress).toBe(false); expect(direct.messages).toEqual([]); expect(direct.counts.messages).toBe(3);
    expect(JSON.stringify(direct)).not.toContain("secret");
    const ingress = await handleRequest(new Request("http://x/api/snapshot", { headers: { "x-ingress-path": "/api/hassio_ingress/abc" } }), fresh(), 11_000).json();
    expect(ingress.viaIngress).toBe(true); expect(ingress.messages[0].text).toBe("<b>secret</b>");
    expect(viaIngress(new Request("http://x/"))).toBe(false);
  });

  test("UI is served at the ingress root with relative API path and escaping", async () => {
    const html = await handleRequest(new Request("http://x/api/hassio_ingress/t/"), fresh()).text();
    expect(html).toContain('fetch("api/snapshot"'); expect(html).toContain("const esc="); expect(html).toContain("FB Stream Ego");
  });

  test("health never echoes the token", async () => {
    const body = JSON.stringify(await handleRequest(new Request("http://x/api/health"), fresh(), 12_000).json());
    expect(body).toContain("exporterTokenConfigured"); expect(body).not.toMatch(/Bearer|EXPORTER_TOKEN/);
  });

  test("refuses write methods and unknown paths", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(handleRequest(new Request("http://x/api/snapshot", { method })).status).toBe(405);
    expect(handleRequest(new Request("http://x/nope")).status).toBe(404);
  });
});
