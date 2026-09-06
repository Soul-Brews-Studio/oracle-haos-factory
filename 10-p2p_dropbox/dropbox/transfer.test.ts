import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TransferRegistry, type CompletedTransfer } from "./transfer";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(maxFileBytes = 1024) {
  const dir = mkdtempSync(join(tmpdir(), "p2p-dropbox-transfer-"));
  dirs.push(dir);
  const completed: CompletedTransfer[] = [];
  const registry = new TransferRegistry({
    saveDir: dir,
    maxFileBytes,
    onComplete: (transfer) => { completed.push(transfer); },
  });
  return { dir, completed, registry };
}

function messages() {
  const sent: any[] = [];
  return { sent, send: (raw: string) => sent.push(JSON.parse(raw)) };
}

describe("ReceiverTransferSession", () => {
  test("isolates binary ownership by DataChannel session", async () => {
    const { registry, completed } = harness();
    const one = messages();
    const two = messages();
    const s1 = registry.createSession("peer-one", one.send);
    const s2 = registry.createSession("peer-two", two.send);

    s1.handleMessage(JSON.stringify({ type: "file-start", id: "one", name: "same.txt", size: 3 }));
    s2.handleMessage(JSON.stringify({ type: "file-start", id: "two", name: "same.txt", size: 3 }));
    s2.handleMessage(Buffer.from("two"));
    s1.handleMessage(Buffer.from("one"));
    s1.handleMessage(JSON.stringify({ type: "file-end", id: "one" }));
    s2.handleMessage(JSON.stringify({ type: "file-end", id: "two" }));
    await Promise.all([s1.settled(), s2.settled()]);

    expect(completed).toHaveLength(2);
    expect(readFileSync(completed.find((x) => x.id === "one")!.savedAs, "utf8")).toBe("one");
    expect(readFileSync(completed.find((x) => x.id === "two")!.savedAs, "utf8")).toBe("two");
    expect(one.sent).toEqual([{ type: "file-received", id: "one", size: 3, ok: true }]);
    expect(two.sent).toEqual([{ type: "file-received", id: "two", size: 3, ok: true }]);
  });

  test("treats binary JSON-looking bytes as file content", async () => {
    const { registry, completed } = harness();
    const out = messages();
    const session = registry.createSession("peer", out.send);
    const payload = Buffer.from('{"type":"file-end","id":"json"}');

    session.handleMessage(JSON.stringify({ type: "file-start", id: "json", name: "json.bin", size: payload.length }));
    session.handleMessage(payload);
    session.handleMessage(JSON.stringify({ type: "file-end", id: "json" }));
    await session.settled();

    expect(readFileSync(completed[0].savedAs)).toEqual(payload);
    expect(out.sent[0].ok).toBe(true);
  });

  test("rejects malformed, oversized, and duplicate active starts", async () => {
    const { registry, completed } = harness(4);
    const one = messages();
    const two = messages();
    const s1 = registry.createSession("peer-one", one.send);
    const s2 = registry.createSession("peer-two", two.send);

    s1.handleMessage(JSON.stringify({ type: "file-start", id: "bad", name: "x", size: -1 }));
    s1.handleMessage(JSON.stringify({ type: "file-start", id: "large", name: "x", size: 5 }));
    s1.handleMessage(JSON.stringify({ type: "file-start", id: "shared", name: "x", size: 1 }));
    s2.handleMessage(JSON.stringify({ type: "file-start", id: "shared", name: "y", size: 1 }));
    s1.handleMessage(Buffer.from("x"));
    s1.handleMessage(JSON.stringify({ type: "file-end", id: "shared" }));
    await s1.settled();

    expect(completed).toHaveLength(1);
    expect(one.sent.slice(0, 2).every((ack) => ack.ok === false)).toBe(true);
    expect(two.sent).toEqual([expect.objectContaining({ id: "shared", ok: false })]);
  });

  test("rejects sensitive filenames before opening a partial file", () => {
    const { dir, registry, completed } = harness();
    const blocked = [
      "production.env", "device.key", "identity.pem", "backup.p12", "archive.pfx",
      "token.secret", "cloud.credentials", "db-password.txt", "client-secret.json",
      "service-credential.json", ".netrc", "id_rsa", "id_ed25519.pub",
    ];

    for (const [index, name] of blocked.entries()) {
      const out = messages();
      const session = registry.createSession(`peer-${index}`, out.send);
      session.handleMessage(JSON.stringify({ type: "file-start", id: `blocked-${index}`, name, size: 1 }));
      expect(out.sent).toEqual([expect.objectContaining({ id: `blocked-${index}`, ok: false })]);
    }

    expect(completed).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("rejects overflow and removes partial files", async () => {
    const { dir, registry, completed } = harness(10);
    const out = messages();
    const session = registry.createSession("peer", out.send);

    session.handleMessage(JSON.stringify({ type: "file-start", id: "overflow", name: "x.bin", size: 2 }));
    session.handleMessage(Buffer.from("abc"));
    await Bun.sleep(20);

    expect(completed).toHaveLength(0);
    expect(out.sent).toEqual([expect.objectContaining({ id: "overflow", size: 0, ok: false })]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("disconnect and incomplete end clean up without success ACK", async () => {
    const { dir, registry, completed } = harness();
    const disconnected = messages();
    const incomplete = messages();
    const s1 = registry.createSession("peer-one", disconnected.send);
    const s2 = registry.createSession("peer-two", incomplete.send);

    s1.handleMessage(JSON.stringify({ type: "file-start", id: "gone", name: "gone.bin", size: 3 }));
    s1.handleMessage(Buffer.from("a"));
    s1.close();
    s2.handleMessage(JSON.stringify({ type: "file-start", id: "short", name: "short.bin", size: 3 }));
    s2.handleMessage(Buffer.from("a"));
    s2.handleMessage(JSON.stringify({ type: "file-end", id: "short" }));
    await s2.settled();
    await Bun.sleep(20);

    expect(completed).toHaveLength(0);
    expect(disconnected.sent).toEqual([expect.objectContaining({ id: "gone", ok: false })]);
    expect(incomplete.sent).toEqual([expect.objectContaining({ id: "short", size: 1, ok: false })]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("commit errors remove the published file and never send a success ACK", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p2p-dropbox-transfer-"));
    dirs.push(dir);
    const registry = new TransferRegistry({
      saveDir: dir,
      maxFileBytes: 10,
      onComplete: () => { throw new Error("index unavailable"); },
    });
    const out = messages();
    const session = registry.createSession("peer", out.send);

    session.handleMessage(JSON.stringify({ type: "file-start", id: "commit", name: "x.bin", size: 1 }));
    session.handleMessage(Buffer.from("x"));
    session.handleMessage(JSON.stringify({ type: "file-end", id: "commit" }));
    await session.settled();

    expect(out.sent).toEqual([expect.objectContaining({ id: "commit", size: 1, ok: false })]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
