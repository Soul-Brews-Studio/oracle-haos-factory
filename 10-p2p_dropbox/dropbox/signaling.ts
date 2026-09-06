import type { SignalingMessage, SignalingPeer } from "./types";
import { createHmac, timingSafeEqual } from "crypto";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const ZOMBIE_TIMEOUT_MS = 60_000;
export const SIGNAL_TOKEN_AUDIENCE = "p2p-dropbox-ws";

export interface SignalingSocket {
  readonly readyState: number;
  send(data: string): number | void;
  close(code?: number, reason?: string): void;
}

interface PeerRecord {
  socket: SignalingSocket;
  name: string;
  lastSeen: number;
}

/** In-memory, room-isolated WebRTC signaling for a single Bun process. */
export class SignalingHub {
  private readonly rooms = new Map<string, Map<string, PeerRecord>>();

  constructor(private readonly now: () => number = Date.now) {}

  connect(room: string, id: string, socket: SignalingSocket): void {
    const peers = this.room(room);
    peers.set(id, { socket, name: "anonymous", lastSeen: this.now() });
    this.send(socket, { type: "welcome", id, peers: peers.size });
    this.broadcast(room, { type: "peer-joined", id, total: peers.size }, id);
  }

  receive(room: string, id: string, raw: string | BufferSource): void {
    const peers = this.rooms.get(room);
    const peer = peers?.get(id);
    if (!peers || !peer) return;
    peer.lastSeen = this.now();

    let message: SignalingMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") return;

    switch (message.type) {
      case "pong":
        return;
      case "identify": {
        peer.name = sanitizePeerName(message.name);
        this.broadcast(room, { type: "peer-identified", id, name: peer.name }, id);
        return;
      }
      case "offer":
      case "answer":
      case "ice-candidate": {
        if (typeof message.target !== "string") return;
        const target = peers.get(message.target);
        if (target?.socket.readyState === 1) {
          this.send(target.socket, { ...message, from: id });
        }
        return;
      }
      case "list-peers": {
        const list: SignalingPeer[] = [...peers].map(([peerId, record]) => ({
          id: peerId,
          name: record.name,
        }));
        this.send(peer.socket, { type: "peer-list", peers: list });
      }
    }
  }

  disconnect(room: string, id: string): void {
    const peers = this.rooms.get(room);
    if (!peers?.delete(id)) return;
    this.broadcast(room, { type: "peer-left", id, total: peers.size });
    if (peers.size === 0) this.rooms.delete(room);
  }

  /** Called every 30 seconds by server.ts. Returns the number of zombies removed. */
  heartbeat(): number {
    const now = this.now();
    let removed = 0;
    for (const [room, peers] of [...this.rooms]) {
      for (const [id, peer] of [...peers]) {
        if (now - peer.lastSeen > ZOMBIE_TIMEOUT_MS) {
          this.disconnect(room, id);
          try { peer.socket.close(1001, "heartbeat timeout"); } catch {}
          removed++;
          continue;
        }
        try {
          this.send(peer.socket, { type: "ping" });
        } catch {
          this.disconnect(room, id);
          try { peer.socket.close(1011, "heartbeat failed"); } catch {}
          removed++;
        }
      }
    }
    return removed;
  }

  peerCount(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  private room(name: string): Map<string, PeerRecord> {
    let peers = this.rooms.get(name);
    if (!peers) {
      peers = new Map();
      this.rooms.set(name, peers);
    }
    return peers;
  }

  private broadcast(room: string, message: SignalingMessage, excludeId?: string): void {
    const peers = this.rooms.get(room);
    if (!peers) return;
    for (const [id, peer] of peers) {
      if (id !== excludeId && peer.socket.readyState === 1) this.send(peer.socket, message);
    }
  }

  private send(socket: SignalingSocket, message: SignalingMessage): void {
    socket.send(JSON.stringify(message));
  }
}

export function sanitizeRoom(value: string | null): string | null {
  const room = (value || "dropbox").trim() || "dropbox";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(room) ? room : null;
}

export function createScopedToken(secret: string, scope: string, ttlSeconds: number, nowMs = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    aud: SIGNAL_TOKEN_AUDIENCE,
    scope,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyScopedToken(token: string, secret: string, requiredScope: string, nowMs = Date.now()): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.aud === SIGNAL_TOKEN_AUDIENCE && claims.scope === requiredScope &&
      Number.isInteger(claims.exp) && claims.exp > Math.floor(nowMs / 1000);
  } catch {
    return false;
  }
}

function sanitizePeerName(value: unknown): string {
  if (typeof value !== "string") return "anonymous";
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return name || "anonymous";
}
