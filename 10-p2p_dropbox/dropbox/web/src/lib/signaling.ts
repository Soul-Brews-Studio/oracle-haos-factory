import { generatePeerName, type SignalingPeer, type PeerInfo, type PeerConnectionStatus } from "./types";
import { PendingIceCandidates } from "./ice";

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const BACKPRESSURE_STALL_MS = 60_000;
const ACK_TIMEOUT_MS = 30_000;

export type DebugCategory = "ws" | "ice" | "sdp" | "dc" | "file";

export type SignalingEvent =
  | { type: "connected"; id: string }
  | { type: "disconnected" }
  | { type: "auth-failed" }
  | { type: "peer-joined"; id: string; name: string; total: number }
  | { type: "peer-left"; id: string; total: number }
  | { type: "p2p-open"; peerId: string }
  | { type: "p2p-closed"; peerId: string }
  | { type: "peers-updated"; peers: PeerInfo[] }
  | { type: "file-receiving"; name: string; size: number; received: number; from?: string }
  | { type: "file-received"; name: string; blob: Blob }
  | { type: "log"; msg: string }
  | { type: "debug"; category: DebugCategory; direction: "out" | "in" | "info"; msg: string };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private myId = "";
  private peers = new Map<string, string>();
  private pcs = new Map<string, RTCPeerConnection>();
  private dcs = new Map<string, RTCDataChannel>();
  private receiving = new Map<string, { name: string; size: number; chunks: ArrayBuffer[]; received: number }>();
  private onEvent: (e: SignalingEvent) => void;
  private wsUrl: string;
  private peerName: string;
  private iceServers: RTCIceServer[];
  private receiverPeerName: string;
  private pendingAcks = new Map<string, (ack: { size: number; ok: boolean }) => void>();
  private reconnect = true;
  private refreshWsUrl?: () => Promise<string>;
  private incomingIce = new PendingIceCandidates();
  private outgoingIce = new Map<string, RTCIceCandidateInit[]>();
  private descriptionSent = new Set<string>();

  constructor(wsUrl: string, onEvent: (e: SignalingEvent) => void, peerName: string | undefined, iceServers: RTCIceServer[], receiverPeerName = "p2p-dropbox", refreshWsUrl?: () => Promise<string>) {
    this.wsUrl = wsUrl;
    this.onEvent = onEvent;
    this.peerName = peerName || generatePeerName("web");
    this.iceServers = iceServers;
    this.receiverPeerName = receiverPeerName;
    this.refreshWsUrl = refreshWsUrl;
  }

  private dbg(category: DebugCategory, direction: "out" | "in" | "info", msg: string) {
    this.onEvent({ type: "debug", category, direction, msg });
  }

  private authConfirmed = false;
  private authFailCount = 0;

  connect() {
    this.reconnect = true;
    this.dbg("ws", "out", `WebSocket connecting → ${this.wsUrl.replace(/(key|token)=[^&]+/, "$1=***")}`);
    this.authConfirmed = false;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      this.dbg("ws", "info", `WebSocket OPEN — identifying as "${this.peerName}"`);
      this.ws!.send(JSON.stringify({ type: "identify", name: this.peerName }));
      this.dbg("ws", "out", `→ {type: "identify", name: "${this.peerName}"}`);
      this.onEvent({ type: "log", msg: "Signaling connected" });
    };

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "error":
          if (msg.code === "ID-TAKEN") {
            this.onEvent({ type: "log", msg: "ID-TAKEN: peer name already registered; choose a different name and reconnect" });
            this.disconnect();
          }
          break;
        case "ping":
          this.ws?.send(JSON.stringify({ type: "pong" }));
          this.dbg("ws", "in", `← ping`);
          this.dbg("ws", "out", `→ pong`);
          break;
        case "welcome":
          this.myId = msg.id;
          this.authConfirmed = true;
          this.authFailCount = 0;
          this.dbg("ws", "in", `← welcome {id: "${msg.id}", peers: ${msg.peers}}`);
          this.onEvent({ type: "connected", id: msg.id });
          this.ws!.send(JSON.stringify({ type: "list-peers" }));
          this.dbg("ws", "out", `→ list-peers`);
          break;
        case "peer-list":
          this.dbg("ws", "in", `← peer-list [${msg.peers.map((p: SignalingPeer) => p.name).join(", ")}]`);
          msg.peers.forEach((p: SignalingPeer) => {
            this.peers.set(p.id, p.name);
            if (p.id !== this.myId && this.isReceiver(p.name)) {
              this.dbg("sdp", "info", `Found receiver "${p.name}" — initiating P2P`);
              this.initP2P(p.id, true);
            }
          });
          this.emitPeersUpdated();
          break;
        case "peer-identified":
          this.peers.set(msg.id, msg.name);
          this.dbg("ws", "in", `← peer-identified {name: "${msg.name}"}`);
          this.onEvent({ type: "peer-joined", id: msg.id, name: msg.name, total: this.peers.size });
          if (msg.id !== this.myId && this.isReceiver(msg.name)) {
            this.dbg("sdp", "info", `Receiver "${msg.name}" joined — initiating P2P`);
            this.initP2P(msg.id, true);
          }
          this.emitPeersUpdated();
          break;
        case "peer-left":
          this.peers.delete(msg.id);
          this.cleanupPeer(msg.id);
          this.onEvent({ type: "peer-left", id: msg.id, total: this.peers.size });
          this.emitPeersUpdated();
          break;
        case "offer":
          this.onEvent({ type: "log", msg: `Ignored incoming offer from ${this.peers.get(msg.from) || msg.from}: browser is sender-only` });
          break;
        case "answer":
          this.handleAnswer(msg);
          break;
        case "ice-candidate":
          this.handleIce(msg);
          break;
      }
    };

    this.ws.onclose = () => {
      if (!this.authConfirmed) {
        this.authFailCount++;
        if (this.authFailCount >= 2) {
          this.dbg("ws", "info", "Auth failed — key rejected by signaling server");
          this.onEvent({ type: "auth-failed" });
          return;
        }
      }
      this.onEvent({ type: "disconnected" });
      this.scheduleReconnect();
    };
  }

  disconnect() {
    this.reconnect = false;
    this.ws?.close();
    this.pcs.forEach((pc) => pc.close());
    this.pcs.clear();
    this.dcs.clear();
    this.pendingAcks.clear();
  }

  private scheduleReconnect() {
    if (!this.reconnect) return;
    setTimeout(async () => {
      if (!this.reconnect) return;
      try {
        if (this.refreshWsUrl) this.wsUrl = await this.refreshWsUrl();
        if (this.reconnect) this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  getMyId() { return this.myId; }
  getPeers() { return new Map(this.peers); }
  hasP2P() { return Array.from(this.dcs.values()).some((dc) => dc.readyState === "open"); }
  hasP2PWith(peerId: string) { return this.dcs.get(peerId)?.readyState === "open"; }

  getPeerList(): PeerInfo[] {
    return Array.from(this.peers.entries())
      .filter(([id]) => id !== this.myId)
      .map(([id, name]) => ({
        id,
        name,
        status: this.getPeerStatus(id),
        isMe: false,
      }));
  }

  private getPeerStatus(peerId: string): PeerConnectionStatus {
    const dc = this.dcs.get(peerId);
    if (dc?.readyState === "open") return "p2p";
    const pc = this.pcs.get(peerId);
    if (pc) {
      const ice = pc.iceConnectionState;
      if (ice === "failed" || ice === "disconnected") return "failed";
      if (ice === "checking" || ice === "new") return "connecting";
    }
    return "online";
  }

  private emitPeersUpdated() {
    this.onEvent({ type: "peers-updated", peers: this.getPeerList() });
  }

  connectToPeer(peerId: string) {
    if (peerId === this.myId) return;
    if (this.dcs.get(peerId)?.readyState === "open") return;
    this.cleanupPeer(peerId);
    const name = this.peers.get(peerId) || peerId.slice(0, 8);
    this.dbg("sdp", "info", `Manual P2P connect to "${name}"`);
    this.initP2P(peerId, true);
    this.emitPeersUpdated();
  }

  async sendFileToPeer(peerId: string, file: File, onProgress?: (pct: number) => void): Promise<boolean> {
    const dc = this.dcs.get(peerId);
    if (!dc || dc.readyState !== "open") return false;
    return this.sendViaDC(dc, file, onProgress);
  }

  private isReceiver(name: string): boolean {
    return name === this.receiverPeerName;
  }

  private initP2P(peerId: string, isInitiator: boolean) {
    if (this.pcs.has(peerId)) return;
    const peerName = this.peers.get(peerId) || peerId.slice(0, 8);
    this.dbg("sdp", "info", `Creating RTCPeerConnection (${isInitiator ? "initiator" : "responder"}) for "${peerName}"`);
    this.dbg("ice", "info", `ICE servers configured: ${this.iceServers.length}`);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pcs.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const c = e.candidate;
        this.dbg("ice", "out", `→ ICE candidate: ${c.candidate?.split(" ").slice(4, 8).join(" ") || "end"}`);
        if (this.descriptionSent.has(peerId)) this.sendIce(peerId, e.candidate.toJSON());
        else this.outgoingIce.set(peerId, [...(this.outgoingIce.get(peerId) || []), e.candidate.toJSON()]);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.dbg("ice", "info", `ICE state: ${pc.iceConnectionState}`);
      this.emitPeersUpdated();
    };

    pc.ondatachannel = (e) => {
      this.dbg("dc", "in", `← DataChannel "${e.channel.label}" received`);
      this.setupDC(e.channel, peerId);
    };

    if (isInitiator) {
      this.dbg("dc", "info", `Creating DataChannel "files" (ordered: true)`);
      const dc = pc.createDataChannel("files", { ordered: true });
      this.setupDC(dc, peerId);
      pc.createOffer().then(async (offer) => {
        this.dbg("sdp", "info", `SDP offer created (${offer.sdp?.length} bytes)`);
        await pc.setLocalDescription(offer);
        this.dbg("sdp", "out", `→ offer via signaling → "${peerName}"`);
        this.ws?.send(JSON.stringify({ type: "offer", target: peerId, sdp: pc.localDescription || offer }));
        this.markDescriptionSent(peerId);
      });
    }
  }

  private setupDC(dc: RTCDataChannel, peerId: string) {
    dc.binaryType = "arraybuffer";
    this.dcs.set(peerId, dc);
    const peerName = this.peers.get(peerId) || peerId.slice(0, 8);

    dc.onopen = () => {
      this.dbg("dc", "info", `DataChannel "${dc.label}" OPEN → "${peerName}" (ordered: ${dc.ordered}, protocol: "${dc.protocol || "none"}")`);
      this.onEvent({ type: "p2p-open", peerId });
      this.onEvent({ type: "log", msg: `P2P open: ${peerName}` });
      this.emitPeersUpdated();
    };

    dc.onmessage = (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.type === "file-start") {
          this.receiving.set(msg.id, { name: msg.name, size: msg.size, chunks: [], received: 0 });
          this.onEvent({ type: "log", msg: `P2P receiving: ${msg.name} (${(msg.size / 1048576).toFixed(1)} MB)` });
        } else if (msg.type === "file-end") {
          const rf = this.receiving.get(msg.id);
          if (rf) {
            const blob = new Blob(rf.chunks);
            this.onEvent({ type: "file-received", name: rf.name, blob });
            this.onEvent({ type: "log", msg: `P2P received: ${rf.name}` });
            this.receiving.delete(msg.id);
          }
        } else if (msg.type === "file-received") {
          this.pendingAcks.get(msg.id)?.({ size: Number(msg.size), ok: Boolean(msg.ok) });
        }
      } else {
        const keys = Array.from(this.receiving.keys());
        if (keys.length > 0) {
          const id = keys[keys.length - 1];
          const rf = this.receiving.get(id)!;
          rf.chunks.push(e.data);
          rf.received += e.data.byteLength;
          this.onEvent({ type: "file-receiving", name: rf.name, size: rf.size, received: rf.received });
        }
      }
    };

    dc.onclose = () => {
      this.dcs.delete(peerId);
      this.onEvent({ type: "p2p-closed", peerId });
      this.emitPeersUpdated();
    };
  }

  private async sendViaDC(dc: RTCDataChannel, file: File, onProgress?: (pct: number) => void): Promise<boolean> {
    const fileId = Math.random().toString(36).slice(2, 10);
    this.dbg("file", "out", `file-start "${file.name}" (${(file.size / 1048576).toFixed(1)} MB, chunk: ${CHUNK_SIZE / 1024}KB)`);
    dc.send(JSON.stringify({ type: "file-start", id: fileId, name: file.name, size: file.size }));

    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);
      const chunk = await slice.arrayBuffer();
      await this.waitForBuffer(dc, MAX_BUFFERED_BYTES);
      dc.send(chunk);
      offset = end;
      onProgress?.((offset / file.size) * 100);
    }

    await this.waitForBuffer(dc, 0);

    const ack = new Promise<{ size: number; ok: boolean }>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingAcks.delete(fileId);
        reject(new Error("Receiver did not confirm the saved file"));
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(fileId, (value) => {
        window.clearTimeout(timer);
        this.pendingAcks.delete(fileId);
        resolve(value);
      });
    });
    dc.send(JSON.stringify({ type: "file-end", id: fileId, size: file.size }));
    this.dbg("file", "out", `file-end "${file.name}" — waiting for receiver save acknowledgement`);
    const result = await ack;
    if (!result.ok || result.size !== file.size) throw new Error(`Receiver saved ${result.size} of ${file.size} bytes`);
    this.onEvent({ type: "log", msg: `Delivered: ${file.name} (receiver confirmed save)` });
    return true;
  }

  private async waitForBuffer(dc: RTCDataChannel, ceiling: number): Promise<void> {
    let lastBuffered = dc.bufferedAmount;
    let stallSince = Date.now();
    while (dc.bufferedAmount > ceiling) {
      if (dc.readyState !== "open") throw new Error("Data channel closed during transfer");
      if (dc.bufferedAmount < lastBuffered) {
        lastBuffered = dc.bufferedAmount;
        stallSince = Date.now();
      } else if (Date.now() - stallSince > BACKPRESSURE_STALL_MS) {
        throw new Error("Data channel made no progress for 60 seconds");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async handleAnswer(msg: { from: string; sdp: RTCSessionDescriptionInit }) {
    try {
      const pc = this.pcs.get(msg.from);
      const name = this.peers.get(msg.from) || msg.from.slice(0, 8);
      this.dbg("sdp", "in", `← answer from "${name}"`);
      if (pc && pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(msg.sdp);
        await this.incomingIce.drain(msg.from, pc);
        this.dbg("sdp", "info", `Remote description set — handshake complete`);
      }
    } catch (e) {
      this.onEvent({ type: "log", msg: `Answer error: ${e}` });
    }
  }

  private async handleIce(msg: { from: string; candidate: RTCIceCandidateInit }) {
    try {
      const pc = this.pcs.get(msg.from);
      if (pc && msg.candidate) {
        const c = msg.candidate.candidate || "";
        this.dbg("ice", "in", `← ICE from "${this.peers.get(msg.from) || "?"}" ${c.split(" ").slice(4, 8).join(" ")}`);
        await this.incomingIce.addOrQueue(msg.from, pc, msg.candidate);
      }
    } catch {
      // ICE candidates before remote description are safe to ignore.
    }
  }

  private cleanupPeer(id: string) {
    this.pcs.get(id)?.close();
    this.pcs.delete(id);
    this.dcs.delete(id);
    this.incomingIce.clear(id);
    this.outgoingIce.delete(id);
    this.descriptionSent.delete(id);
  }

  private sendIce(peerId: string, candidate: RTCIceCandidateInit) {
    this.ws?.send(JSON.stringify({ type: "ice-candidate", target: peerId, candidate }));
  }

  private markDescriptionSent(peerId: string) {
    this.descriptionSent.add(peerId);
    for (const candidate of this.outgoingIce.get(peerId) || []) this.sendIce(peerId, candidate);
    this.outgoingIce.delete(peerId);
  }
}
