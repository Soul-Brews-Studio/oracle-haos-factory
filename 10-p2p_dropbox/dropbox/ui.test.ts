import { describe, expect, test } from "bun:test";
import { findExactReceiver, findUniqueReceiver, resolveAppUrl } from "./web/src/lib/routing";
import { PendingIceCandidates } from "./web/src/lib/ice";

describe("ingress-relative frontend routing", () => {
  test("keeps API calls under the Home Assistant ingress prefix", () => {
    expect(resolveAppUrl("https://ha.example/api/hassio_ingress/addon-token/", "/api/config"))
      .toBe("https://ha.example/api/hassio_ingress/addon-token/api/config");
  });

  test("selects only the exact configured receiver", () => {
    const peers = [
      { id: "arbitrary", name: "web-receiver" },
      { id: "target", name: "p2p-dropbox" },
      { id: "similar", name: "p2p-dropbox-demo" },
    ];
    expect(findExactReceiver(peers, "p2p-dropbox")?.id).toBe("target");
    expect(findUniqueReceiver(peers, "p2p-dropbox")?.id).toBe("target");
    expect(findExactReceiver(peers, "missing")).toBeUndefined();
  });

  test("does not auto-select ambiguous duplicate receiver names", () => {
    expect(findUniqueReceiver([
      { id: "old", name: "p2p-dropbox" },
      { id: "new", name: "p2p-dropbox" },
    ], "p2p-dropbox")).toBeUndefined();
  });
});

describe("browser ICE ordering", () => {
  test("queues candidates received before the answer and drains afterward", async () => {
    const added: RTCIceCandidateInit[] = [];
    const pc = {
      remoteDescription: null as unknown,
      async addIceCandidate(candidate: RTCIceCandidateInit) { added.push(candidate); },
    };
    const pending = new PendingIceCandidates();
    const candidate = { candidate: "candidate-before-answer" };

    await pending.addOrQueue("receiver", pc, candidate);
    expect(added).toEqual([]);
    pc.remoteDescription = { type: "answer" };
    await pending.drain("receiver", pc);
    expect(added).toEqual([candidate]);
  });
});
