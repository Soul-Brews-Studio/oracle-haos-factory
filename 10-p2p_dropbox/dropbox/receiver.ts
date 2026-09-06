#!/usr/bin/env bun
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } from "werift";
import { join, resolve } from "path";
import { mkdirSync, appendFileSync } from "fs";
import type { SignalingPeer, SdpPayload, RTCIceCandidateJSON } from "./types";
import { ReceiverTransferSession, TransferRegistry } from "./transfer";
import { gatheredLocalDescription } from "./negotiation";

const SIGNAL_URL = process.env.SIGNAL_URL || "ws://127.0.0.1:3847/ws";
const AUTH_KEY = process.env.AUTH_KEY || "";
if (!AUTH_KEY.trim()) throw new Error("AUTH_KEY is required");
const SAVE_DIR = resolve(process.env.SAVE_DIR || "./uploads");
const INDEX_FILE = join(SAVE_DIR, "index.jsonl");
const LOG_DIR = resolve(process.env.LOG_DIR || "./logs");
const PEER_NAME = process.env.PEER_NAME || "p2p-dropbox";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || "1024");
if (!Number.isFinite(MAX_FILE_MB) || MAX_FILE_MB <= 0) throw new Error("MAX_FILE_MB must be greater than zero");
const MAX_FILE_BYTES = Math.floor(MAX_FILE_MB * 1024 * 1024);
const DEFAULT_STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
// pin werift's UDP port range (env ICE_PORT_MIN/MAX) for port-forwardable, pure-P2P transport
const _ICE_MIN = Number(process.env.ICE_PORT_MIN || 0);
const _ICE_MAX = Number(process.env.ICE_PORT_MAX || 0);
const ICE_PORT_RANGE: [number, number] | undefined =
  _ICE_MIN && _ICE_MAX ? [_ICE_MIN, _ICE_MAX] : undefined;

mkdirSync(SAVE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  appendFileSync(join(LOG_DIR, `receiver_${ts.slice(0, 10)}.log`), line + "\n");
}

function todayDir(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const dir = join(SAVE_DIR, `${yyyy}-${mm}-${dd}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface IndexEntry {
  ts: string;
  originalName: string;
  savedAs: string;
  date: string;
  size: number;
  sender: string;
  senderId: string;
}

const peerNames = new Map<string, string>();

function writeIndex(entry: IndexEntry) {
  appendFileSync(INDEX_FILE, JSON.stringify(entry) + "\n");
}

const peerConnections = new Map<string, RTCPeerConnection>();
let myId = "";
let ws: WebSocket;
let shuttingDown = false;
const transferSessions = new Set<ReceiverTransferSession>();

function signalingUrl(): string {
  const url = new URL(SIGNAL_URL);
  url.searchParams.set("key", AUTH_KEY);
  return url.toString();
}

function configuredIceServers() {
  let stunServers: string[];
  try {
    stunServers = JSON.parse(process.env.STUN_SERVERS || JSON.stringify(DEFAULT_STUN_SERVERS));
  } catch {
    throw new Error("STUN_SERVERS must be a JSON array of URLs");
  }
  if (!Array.isArray(stunServers) || !stunServers.every((url) => typeof url === "string" && url.length > 0)) {
    throw new Error("STUN_SERVERS must be a JSON array of URLs");
  }
  const servers: any[] = stunServers.map((urls) => ({ urls }));
  if (process.env.TURN_URLS && process.env.TURN_USER && process.env.TURN_CRED) {
    let turnUrls: string[];
    try {
      const parsed = JSON.parse(process.env.TURN_URLS);
      turnUrls = Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      turnUrls = process.env.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean);
    }
    servers.push(...turnUrls.map((urls) => ({ urls, username: process.env.TURN_USER!, credential: process.env.TURN_CRED! })));
  }
  return servers;
}

const transferRegistry = new TransferRegistry({
  saveDir: todayDir(),
  maxFileBytes: MAX_FILE_BYTES,
  log,
  onComplete: (transfer) => {
    const senderName = peerNames.get(transfer.senderPeerId) || transfer.senderPeerId.slice(0, 8);
    writeIndex({
      ts: new Date().toISOString(),
      originalName: transfer.originalName,
      savedAs: transfer.savedAs,
      date: new Date().toISOString().slice(0, 10),
      size: transfer.size,
      sender: senderName,
      senderId: transfer.senderPeerId,
    });
    log(`Saved: ${transfer.savedAs} (${(transfer.size / 1048576).toFixed(1)} MB) from ${senderName}`);
  },
});

function connectSignaling() {
  log(`Connecting to signaling: ${SIGNAL_URL}`);
  ws = new WebSocket(signalingUrl());

  ws.onopen = () => {
    log("Signaling connected");
    ws.send(JSON.stringify({ type: "identify", name: PEER_NAME }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(String(event.data));

    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "welcome":
        myId = msg.id;
        log(`Registered as ${PEER_NAME} (${myId}) — ${msg.peers} peers online`);
        ws.send(JSON.stringify({ type: "list-peers" }));
        break;

      case "peer-list":
        for (const p of msg.peers as SignalingPeer[]) peerNames.set(p.id, p.name);
        log(`Peers online: ${msg.peers.map((p: SignalingPeer) => p.name).join(", ")}`);
        break;

      case "peer-identified":
        peerNames.set(msg.id, msg.name);
        log(`Peer joined: ${msg.name} (${msg.id})`);
        break;

      case "peer-left":
        log(`Peer left: ${msg.id} (total: ${msg.total})`);
        peerNames.delete(msg.id);
        peerConnections.get(msg.id)?.close();
        peerConnections.delete(msg.id);
        break;

      case "offer":
        await handleOffer(msg);
        break;

      case "answer":
        await handleAnswer(msg);
        break;

      case "ice-candidate":
        await handleIce(msg);
        break;
    }
  };

  ws.onclose = () => {
    if (shuttingDown) return;
    log("Signaling disconnected — reconnecting in 5s");
    setTimeout(connectSignaling, 5000);
  };

  ws.onerror = (err) => {
    log(`Signaling error: ${err}`);
  };
}

function setupDataChannel(dc: RTCDataChannel, peerId: string) {
  log(`DataChannel open with ${peerId}`);

  const session = transferRegistry.createSession(peerId, (message) => dc.send(message));
  transferSessions.add(session);

  dc.onMessage.subscribe((data: Buffer | string) => {
    session.handleMessage(data);
  });

  dc.stateChanged.subscribe?.((state: string) => {
    if (state === "closed") {
      log(`DataChannel closed with ${peerId}`);
      session.close();
      transferSessions.delete(session);
    }
  });
}

async function handleOffer(msg: { from: string; sdp: SdpPayload }) {
  log(`Offer from ${msg.from}`);

  const pc = new RTCPeerConnection({
    iceServers: configuredIceServers(),
    // pin werift's UDP port range (env ICE_PORT_MIN/MAX) so the receiver's
    // candidates are predictable and can be port-forwarded — pure P2P, no relay.
    ...(ICE_PORT_RANGE ? { icePortRange: ICE_PORT_RANGE } : {}),
  } as any);
  peerConnections.set(msg.from, pc);

  // surface ICE state so symmetric-NAT stalls are diagnosable, not silent
  (pc as any).iceConnectionStateChange?.subscribe?.((s: string) =>
    log(`ICE state [${msg.from.slice(0, 8)}]: ${s}`));

  pc.onIceCandidate.subscribe((candidate) => {
    ws.send(JSON.stringify({
      type: "ice-candidate",
      target: msg.from,
      candidate: candidate.toJSON(),
    }));
  });

  pc.onDataChannel.subscribe((dc) => {
    setupDataChannel(dc, msg.from);
  });

  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp.sdp, msg.sdp.type as "offer" | "answer"));
  const answer = await pc.createAnswer();
  const gatheredAnswer = await gatheredLocalDescription(pc, answer);

  ws.send(JSON.stringify({
    type: "answer",
    target: msg.from,
    sdp: gatheredAnswer,
  }));
  log(`Answer sent to ${msg.from}`);
}

async function handleAnswer(msg: { from: string; sdp: SdpPayload }) {
  const pc = peerConnections.get(msg.from);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp.sdp, msg.sdp.type as "offer" | "answer"));
    log(`Answer from ${msg.from}`);
  }
}

async function handleIce(msg: { from: string; candidate: RTCIceCandidateJSON }) {
  const pc = peerConnections.get(msg.from);
  if (pc && msg.candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  }
}

// #104: werift's UDP socket throws uncaught ECONNREFUSED when a peer's socket
// vanishes mid-flight (ICMP port unreachable) — that must not kill the daemon.
// This was the likely cause of the "phd-receiver disappeared silently" scar.
// Hardening: survive ONLY the known network-error class; anything else is a real
// bug — log FATAL and exit 1 so pm2 restarts us instead of us swallowing it.
const SURVIVABLE_NET_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"]);

process.on("uncaughtException", (err: any) => {
  if (SURVIVABLE_NET_ERRORS.has(err?.code)) {
    log(`NET ERROR (surviving, #104): ${err.code} — a peer vanished mid-transfer`);
    return;
  }
  log(`FATAL uncaught: ${err?.stack || err} — exiting for pm2 restart`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: any) => {
  if (SURVIVABLE_NET_ERRORS.has(reason?.code)) {
    log(`NET REJECTION (surviving, #104): ${reason.code} — a peer vanished mid-transfer`);
    return;
  }
  log(`FATAL rejection: ${reason?.stack || reason} — exiting for pm2 restart`);
  process.exit(1);
});

log(`
╔══════════════════════════════════════════╗
║  🛰️  PhD Dropbox — P2P Receiver         ║
║                                          ║
║  Name:     ${PEER_NAME.padEnd(28)}║
║  Save dir: ${SAVE_DIR.slice(-28).padEnd(28)}║
║  Signal:   ${SIGNAL_URL.slice(0, 28).padEnd(28)}║
║                                          ║
║  Waiting for peers to send files...      ║
╚══════════════════════════════════════════╝
`);

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — closing receiver cleanly`);
  for (const session of transferSessions) session.close("receiver shutting down");
  transferSessions.clear();
  for (const pc of peerConnections.values()) pc.close();
  peerConnections.clear();
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 100);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

connectSignaling();
