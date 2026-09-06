import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const auth = crypto.randomUUID();
const root = mkdtempSync(join(tmpdir(), "p2p-http-bound-"));
const port = 31000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  child = Bun.spawn(["bun", "server.ts"], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore", env: {
    ...process.env, AUTH_KEY: auth, PORT: String(port), HOST: "127.0.0.1", MAX_FILE_MB: "1024",
    STUN_SERVERS: "[]", TURN_URLS: "", UPLOAD_DIR: join(root, "uploads"), LOG_DIR: join(root, "logs"),
  } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch {}
    await Bun.sleep(20);
  }
  throw new Error("HTTP-bound server not ready");
});
afterAll(async () => { child?.kill(); await child?.exited; rmSync(root, { recursive: true, force: true }); });

test("HTTP buffering has a 32 MiB ceiling independent of larger P2P maximum", async () => {
  const config = await (await fetch(base + "/api/config", { headers: { authorization: `Bearer ${auth}` } })).json();
  expect(config.max_file_mb).toBe(1024);
  expect(config.http_max_file_mb).toBe(32);
  const result = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("body ceiling response timed out")), 2000);
    Bun.connect({ hostname: "127.0.0.1", port, socket: {
      open(socket) {
        socket.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${auth}\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: ${34 * 1024 * 1024}\r\nConnection: close\r\n\r\n`);
      },
      data(socket, data) { clearTimeout(timer); resolve(data.toString()); socket.end(); },
      error(_socket, error) { clearTimeout(timer); reject(error); },
    } }).catch(reject);
  });
  expect(result).toContain("413");
});

test("only one buffered HTTP upload can be active", async () => {
  const stalled = await Bun.connect({ hostname: "127.0.0.1", port, socket: {
    open(socket) { socket.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${auth}\r\nContent-Type: multipart/form-data; boundary=stall\r\nContent-Length: 1000\r\n\r\n--stall\r\n`); },
    data() {}, error() {},
  } });
  try {
    await Bun.sleep(50);
    const form = new FormData(); form.set("file", new File(["fixture"], "fixture.txt"));
    const response = await fetch(base + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: form });
    expect(response.status).toBe(429);
  } finally { stalled.end(); }
});
