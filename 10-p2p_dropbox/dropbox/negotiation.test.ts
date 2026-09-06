import { expect, test } from "bun:test";
import { RTCPeerConnection } from "werift";
import { gatheredLocalDescription } from "./negotiation";

test("signals werift's post-gather local SDP instead of the candidate-free draft", async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    pc.createDataChannel("files", { ordered: true });
    const draft = await pc.createOffer();
    expect(draft.sdp).not.toContain("a=candidate:");

    const gathered = await gatheredLocalDescription(pc, draft);

    expect(gathered.type).toBe("offer");
    expect(gathered.sdp).toBe(pc.localDescription?.sdp);
    expect(gathered.sdp).toContain("a=candidate:");
  } finally {
    pc.close();
  }
});
