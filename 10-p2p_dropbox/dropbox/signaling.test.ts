import { describe, expect, test } from "bun:test";
import { createScopedToken, SignalingHub, sanitizeRoom, verifyScopedToken, ZOMBIE_TIMEOUT_MS } from "./signaling";

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

  test("rejects a duplicate identified name without disturbing the incumbent", () => {
    const hub = new SignalingHub(() => 0);
    const incumbent = new FakeSocket(), duplicate = new FakeSocket();
    hub.connect("dropbox", "incumbent", incumbent);
    hub.connect("dropbox", "duplicate", duplicate);
    incumbent.take(); duplicate.take();

    hub.receive("dropbox", "incumbent", JSON.stringify({ type: "identify", name: "p2p-dropbox" }));
    incumbent.take();
    duplicate.take();
    hub.receive("dropbox", "duplicate", JSON.stringify({ type: "identify", name: "p2p-dropbox" }));

    expect(duplicate.take()).toEqual([{
      type: "error",
      code: "ID-TAKEN",
      message: "Peer name 'p2p-dropbox' is already registered in this room",
    }]);
    expect(duplicate.closed).toEqual({ code: 1008, reason: "ID-TAKEN" });
    expect(hub.peerCount("dropbox")).toBe(1);
    expect(incumbent.closed).toBeUndefined();
    hub.receive("dropbox", "incumbent", JSON.stringify({ type: "list-peers" }));
    expect(incumbent.sent.at(-1)).toEqual({
      type: "peer-list",
      peers: [{ id: "incumbent", name: "p2p-dropbox" }],
    });
  });

  test("checks uniqueness after sanitizing names", () => {
    const hub = new SignalingHub(() => 0);
    const incumbent = new FakeSocket(), duplicate = new FakeSocket();
    hub.connect("dropbox", "a", incumbent);
    hub.connect("dropbox", "b", duplicate);
    incumbent.take(); duplicate.take();

    hub.receive("dropbox", "a", JSON.stringify({ type: "identify", name: " receiver " }));
    incumbent.take();
    hub.receive("dropbox", "b", JSON.stringify({ type: "identify", name: "\u0000receiver\u007f" }));

    expect(duplicate.sent.at(-1)).toMatchObject({ type: "error", code: "ID-TAKEN" });
    expect(duplicate.closed).toEqual({ code: 1008, reason: "ID-TAKEN" });
  });

  test("allows the same peer to reidentify with its own name and the same name in another room", () => {
    const hub = new SignalingHub(() => 0);
    const first = new FakeSocket(), otherRoom = new FakeSocket();
    hub.connect("alpha", "a", first);
    hub.connect("beta", "b", otherRoom);
    first.take(); otherRoom.take();

    hub.receive("alpha", "a", JSON.stringify({ type: "identify", name: "sender" }));
    hub.receive("alpha", "a", JSON.stringify({ type: "identify", name: "sender" }));
    hub.receive("beta", "b", JSON.stringify({ type: "identify", name: "sender" }));

    expect(first.closed).toBeUndefined();
    expect(otherRoom.closed).toBeUndefined();
    expect(hub.peerCount("alpha")).toBe(1);
    expect(hub.peerCount("beta")).toBe(1);
  });

  test("does not reserve anonymous names until identify and releases names on rename and disconnect", () => {
    const hub = new SignalingHub(() => 0);
    const anonymousA = new FakeSocket(), anonymousB = new FakeSocket();
    hub.connect("dropbox", "anon-a", anonymousA);
    hub.connect("dropbox", "anon-b", anonymousB);
    expect(hub.peerCount("dropbox")).toBe(2);

    hub.receive("dropbox", "anon-a", JSON.stringify({ type: "identify", name: "first" }));
    hub.receive("dropbox", "anon-a", JSON.stringify({ type: "identify", name: "renamed" }));
    const claimant = new FakeSocket();
    hub.connect("dropbox", "claimant", claimant);
    claimant.take();
    hub.receive("dropbox", "claimant", JSON.stringify({ type: "identify", name: "first" }));
    expect(claimant.closed).toBeUndefined();

    hub.disconnect("dropbox", "anon-a");
    const successor = new FakeSocket();
    hub.connect("dropbox", "successor", successor);
    successor.take();
    hub.receive("dropbox", "successor", JSON.stringify({ type: "identify", name: "renamed" }));
    expect(successor.closed).toBeUndefined();
  });

  test("releases an identified name when heartbeat removes a zombie", () => {
    let now = 0;
    const hub = new SignalingHub(() => now);
    const zombie = new FakeSocket();
    hub.connect("dropbox", "zombie", zombie);
    zombie.take();
    hub.receive("dropbox", "zombie", JSON.stringify({ type: "identify", name: "receiver" }));

    now = ZOMBIE_TIMEOUT_MS + 1;
    expect(hub.heartbeat()).toBe(1);
    const successor = new FakeSocket();
    hub.connect("dropbox", "successor", successor);
    successor.take();
    hub.receive("dropbox", "successor", JSON.stringify({ type: "identify", name: "receiver" }));

    expect(successor.closed).toBeUndefined();
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
  expect(sanitizeRoom(null)).toBe("default");
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
