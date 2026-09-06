export interface LocalDescription {
  type: "offer" | "answer";
  sdp: string;
}

interface GatheringPeerConnection {
  localDescription?: { type?: string; sdp?: string };
  setLocalDescription(description: LocalDescription): Promise<unknown>;
}

/**
 * werift gathers ICE during setLocalDescription and updates pc.localDescription.
 * Returning the original createOffer/createAnswer value would omit those gathered
 * candidates and make early trickle messages the only copy.
 */
export async function gatheredLocalDescription(
  pc: GatheringPeerConnection,
  draft: LocalDescription,
): Promise<LocalDescription> {
  await pc.setLocalDescription(draft);
  const gathered = pc.localDescription;
  if (!gathered?.sdp || gathered.type !== draft.type) {
    throw new Error(`werift did not produce a gathered local ${draft.type}`);
  }
  return { type: draft.type, sdp: gathered.sdp };
}
