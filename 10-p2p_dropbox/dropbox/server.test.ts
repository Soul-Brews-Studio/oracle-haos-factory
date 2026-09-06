import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createScopedToken } from "./signaling";

const auth = `fixture-${crypto.randomUUID()}`;
const root = mkdtempSync(join(tmpdir(), "p2p-dropbox-test-"));
const port = 20_000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  child = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      AUTH_KEY: auth,
      HOST: "127.0.0.1",
      PORT: String(port),
      MAX_FILE_MB: "1",
      STUN_SERVERS: '["stun:test.invalid:3478"]',
      TURN_URLS: '["turn:test.invalid:3478"]',
      TURN_USER: "turn-user",
      TURN_CRED: "turn-pass",
      UPLOAD_DIR: join(root, "uploads"),
      LOG_DIR: join(root, "logs"),
    },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await Bun.sleep(20);
  }
  throw new Error("test server did not become ready");
});

afterAll(() => child?.kill());

describe("server", () => {
  test("keeps health public and configuration authenticated", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/config`)).status).toBe(401);
    const response = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${auth}` } });
    expect(response.status).toBe(200);
    const config = await response.json();
    expect(config).toMatchObject({
      max_file_mb: 1,
      http_max_file_mb: 1,
      receiver_peer_name: "p2p-dropbox",
      iceServers: [
        { urls: "stun:test.invalid:3478" },
        { urls: "turn:test.invalid:3478", username: "turn-user", credential: "turn-pass" },
      ],
    });
    expect(config.signal_token).toBeString();
    expect(JSON.stringify(config)).not.toContain(auth);
  });

  test("uploads bounded files without overwriting and downloads as attachments", async () => {
    const upload = async () => {
      const body = new FormData();
      body.set("file", new File(["fixture bytes\n"], "fixture.txt"));
      return fetch(`${base}/api/upload`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body });
    };
    const first = await (await upload()).json();
    const second = await (await upload()).json();
    expect(first.name).not.toBe(second.name);
    const downloaded = await fetch(`${base}/api/files/${encodeURIComponent(first.name)}?date=${first.date}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded.headers.get("content-disposition")).toStartWith("attachment;");
    expect(await downloaded.text()).toBe("fixture bytes\n");
  });

  test("does not follow upload-directory symlinks", async () => {
    symlinkSync("/etc/passwd", join(root, "uploads", "outside.txt"));
    writeFileSync(join(root, "uploads", "incomplete.part"), "partial");
    const response = await fetch(`${base}/api/files/outside.txt`, { headers: { authorization: `Bearer ${auth}` } });
    expect(response.status).toBe(404);
    expect((await fetch(`${base}/api/files/incomplete.part`, { headers: { authorization: `Bearer ${auth}` } })).status).toBe(404);
    const listing = await (await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${auth}` } })).json();
    expect(listing.files.some((file: { name: string }) => file.name.endsWith(".part"))).toBeFalse();
    expect(readFileSync("/etc/passwd", "utf8").length).toBeGreaterThan(0);
  });

  test("accepts signal tokens but rejects watch-scoped tokens", async () => {
    const config = await (await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${auth}` } })).json();
    const connected = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(config.signal_token)}`);
      ws.onopen = () => { ws.close(); resolve(); };
      ws.onerror = () => reject(new Error("signal token websocket was rejected"));
    });
    await connected;
    const watch = createScopedToken(auth, "watch", 300);
    const rejected = await fetch(`${base}/ws?token=${encodeURIComponent(watch)}`, {
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    expect(rejected.status).toBe(401);
    expect((await fetch(`${base}/watch/fixture`)).status).toBe(404);
  });
});
test("published port cannot spoof ingress with forwarded/user/admin headers", async () => {
  const response=await fetch(`${base}/auth/ingress`,{method:"POST",headers:{"x-ingress-path":"/api/hassio_ingress/proof","x-remote-user-id":"admin","x-remote-user-is-admin":"true","x-forwarded-for":"172.30.32.2","x-real-ip":"172.30.32.2"}});
  expect(response.status).toBe(403);const body=await response.json();expect(body.ingress).toBeFalse();expect(body.user_id).toBe("");expect(body.token).toBeUndefined();
});
