import { describe, expect, test } from "bun:test";
import { handleRequest, isSnapshot, type KvmSnapshot, type MonitorState } from "./server";

const snapshot: KvmSnapshot = {
  generatedAt: "2026-09-01T16:00:00Z",
  host: { name: "kvmbox-pve1", load: [0.1, 0.2, 0.3], memoryKiB: { total: 1024, available: 512 }, diskBytes: { total: 2048, free: 1024 } },
  guests: [{ name: "kvmlab1", state: "running", memoryKiB: { actual: 2048 }, interfaces: [], disks: [] }],
  errors: [],
};

describe("kvm monitor", () => {
  test("accepts a valid exporter snapshot", () => expect(isSnapshot(snapshot)).toBe(true));
  test("rejects malformed exporter data", () => expect(isSnapshot({ generatedAt: "now" })).toBe(false));

  test("serves fresh data and health", () => {
    const now = 10_000;
    const store: MonitorState = { snapshot, fetchedAt: now, lastError: null };
    expect(handleRequest(new Request("http://x/api/health"), store, now).status).toBe(200);
    expect(handleRequest(new Request("http://x/api/snapshot"), store, now).status).toBe(200);
  });

  test("marks missing data unavailable", async () => {
    const store: MonitorState = { snapshot: null, fetchedAt: null, lastError: "offline" };
    const response = handleRequest(new Request("http://x/api/health"), store, 10_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unavailable", lastError: "offline" });
  });

  test("refuses write methods", () => {
    expect(handleRequest(new Request("http://x/api/snapshot", { method: "POST" })).status).toBe(405);
  });
});
