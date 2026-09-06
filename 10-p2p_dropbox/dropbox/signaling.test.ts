import { describe, expect, test } from "bun:test";
import { createScopedToken, SignalingHub, sanitizeRoom, verifyScopedToken } from "./signaling";

class FakeSocket {
  readyState = 1;
  sent: any[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  take() { return this.sent.splice(0); }
}

describe("SignalingHub", () => {
  test("relays offer, answer, and ICE only inside the authenticated connection's room", () => {
    const hub = new SignalingHub(() => 0);
    const a = new FakeSocket(), b = new FakeSocket(), outsider = new FakeSocket();
    hub.connect("alpha", "a", a);
    hub.connect("alpha", "b", b);
    hub.connect("beta", "b", outsider);
    a.take(); b.take(); outsider.take();

    for (const type of ["offer", "answer", "ice-candidate"]) {
      hub.receive("alpha", "a", JSON.stringify({ type, target: "b", payload: type }));
    }

    expect(b.take()).toEqual([
      { type: "offer", target: "b", payload: "offer", from: "a" },
      { type: "answer", target: "b", payload: "answer", from: "a" },
      { type: "ice-candidate", target: "b", payload: "ice-candidate", from: "a" },
    ]);
    expect(outsider.take()).toEqual([]);
  });

  test("peer lists and presence notifications are room-isolated", () => {
    const hub = new SignalingHub(() => 0);
    const a = new FakeSocket(), b = new FakeSocket(), other = new FakeSocket();
    hub.connect("one", "a", a);
    hub.connect("one", "b", b);
    hub.connect("two", "c", other);
    a.take(); b.take(); other.take();
    hub.receive("one", "a", JSON.stringify({ type: "identify", name: " sender " }));
    hub.receive("one", "a", JSON.stringify({ type: "list-peers" }));
    expect(a.sent.at(-1)).toEqual({ type: "peer-list", peers: [{ id: "a", name: "sender" }, { id: "b", name: "anonymous" }] });
    expect(other.sent).toEqual([]);
  });

  test("ignores malformed and non-object JSON messages without disconnecting", () => {
    const hub = new SignalingHub(() => 0);
    const peer = new FakeSocket();
    hub.connect("dropbox", "peer", peer);
    peer.take();
    for (const raw of ["null", "[]", '"identify"', "7", "{}", "not-json"]) {
      expect(() => hub.receive("dropbox", "peer", raw)).not.toThrow();
    }
    expect(peer.take()).toEqual([]);
  });

  test("pings at a heartbeat and removes peers only after 60 seconds without activity", () => {
    let now = 0;
    const hub = new SignalingHub(() => now);
    const alive = new FakeSocket(), zombie = new FakeSocket();
    hub.connect("dropbox", "alive", alive);
    hub.connect("dropbox", "zombie", zombie);
    alive.take(); zombie.take();
    now = 60_000;
    hub.receive("dropbox", "alive", '{"type":"pong"}');
    expect(hub.heartbeat()).toBe(0);
    expect(zombie.take()).toEqual([{ type: "ping" }]);
    now = 60_001;
    expect(hub.heartbeat()).toBe(1);
    expect(zombie.closed).toEqual({ code: 1001, reason: "heartbeat timeout" });
    expect(hub.peerCount("dropbox")).toBe(1);
  });
});

test("room names are bounded and default safely", () => {
  expect(sanitizeRoom(null)).toBe("dropbox");
  expect(sanitizeRoom("lab-1")).toBe("lab-1");
  expect(sanitizeRoom("../escape")).toBeNull();
});

test("scoped HMAC tokens enforce signature, audience, scope, and expiry", () => {
  const secret = "fixture-only-test-secret";
  const signal = createScopedToken(secret, "signal", 300, 1_000_000);
  const watch = createScopedToken(secret, "watch", 300, 1_000_000);
  expect(verifyScopedToken(signal, secret, "signal", 1_100_000)).toBeTrue();
  expect(verifyScopedToken(watch, secret, "signal", 1_100_000)).toBeFalse();
  expect(verifyScopedToken(signal, secret, "signal", 1_300_000)).toBeFalse();
  expect(verifyScopedToken(signal + "x", secret, "signal", 1_100_000)).toBeFalse();
});
