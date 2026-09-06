export interface SignalingPeer {
  id: string;
  name: string;
}

export type PeerConnectionStatus = "online" | "connecting" | "p2p" | "failed";

export interface PeerInfo {
  id: string;
  name: string;
  status: PeerConnectionStatus;
  isMe: boolean;
}

export function generatePeerName(prefix: string): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const hash = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${hh}${mm}-${hash}`;
}
