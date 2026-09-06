#!/usr/bin/env bun
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } from "werift";
import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { generatePeerName, type SignalingPeer } from "./types";
import { gatheredLocalDescription } from "./negotiation";

import { signalingClientUrl } from "./client-url";

const SIGNAL_URL = process.env.SIGNAL_URL || "ws://127.0.0.1:3847/ws";
const AUTH_KEY = process.env.AUTH_KEY || "";
const PEER_NAME = process.env.PEER_NAME || generatePeerName("cli");
const CHUNK_SIZE = 64 * 1024;
// #104: how long to wait for the receiver's file-received ack before declaring failure
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS) || 30_000;
// hardening: bound the post-send drain loop — a dead channel must not hang the CLI forever
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS) || 60_000;
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS) || 30_000;
const DEFAULT_STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

// network-class errors werift's UDP socket can throw when the far side vanishes;
// anything else is a real bug and should crash loudly
const NET_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"]);

process.on("uncaughtException", (err: any) => {
  if (NET_ERRORS.has(err?.code)) {
    console.error(`\n[send] peer socket vanished mid-transfer (${err.code}) — delivery NOT confirmed`);
    process.exit(2);
  }
  console.error(`\n[send] FATAL: ${err?.stack || err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: any) => {
  if (NET_ERRORS.has(reason?.code)) {
    console.error(`\n[send] peer socket vanished mid-transfer (${reason.code}) — delivery NOT confirmed`);
    process.exit(2);
  }
  console.error(`\n[send] FATAL rejection: ${reason?.stack || reason}`);
  process.exit(1);
});

const rawArgs = process.argv.slice(2);

let targetName = "";
const filePaths: string[] = [];
let listPeers = false;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--to" || rawArgs[i] === "-t") {
    targetName = rawArgs[++i] || "";
  } else if (rawArgs[i] === "--list" || rawArgs[i] === "-l") {
    listPeers = true;
  } else if (rawArgs[i] === "--help" || rawArgs[i] === "-h") {
    console.log(`
  PhD Dropbox — CLI P2P Sender (WebRTC)

  Usage:
    bun run send.ts <file> [file2...]              Send to p2p-dropbox (default, exact name)
    bun run send.ts --to <peer-name> <file>        Send to specific peer (exact match wins)
    bun run send.ts --list                         List online peers

  Env:
    SIGNAL_URL=ws://host:3847/ws  Local signaling endpoint
    ROOM=default             Room (overrides SIGNAL_URL ?room=)
    AUTH_KEY=phd-xxx          Signaling auth key (required)
    PEER_NAME=my-oracle       Your peer name (default: cli-HHMM-hash)
    DEFAULT_PEER=p2p-dropbox  Target for bare send (no --to)

  Target resolution: exact name first; substring only if unambiguous; else FAIL LOUD.

  Examples:
    maw dropbox send file.txt                      Send to p2p-dropbox
    maw dropbox send --to chaiklang-recv file.txt   Send to chaiklang-recv
    maw dropbox send --list                        Show who's online
`);
    process.exit(0);
  } else if (!rawArgs[i].startsWith("-")) {
    filePaths.push(rawArgs[i]);
  }
}

if (!listPeers && filePaths.length === 0) {
  console.error("No files specified. Use --help for usage.");
  process.exit(1);
}
if (!AUTH_KEY.trim()) {
  console.error("AUTH_KEY is required");
  process.exit(1);
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

let ws: WebSocket;
let myId = "";
let receiverId = "";
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let connected = false;
let connectionTimer: ReturnType<typeof setTimeout> | null = null;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// bare send (no --to) goes to the home receiver by EXACT name — never a
// substring heuristic. Override with DEFAULT_PEER.
const DEFAULT_PEER = process.env.DEFAULT_PEER || "p2p-dropbox";

function signalingUrl(): string {
  return signalingClientUrl(SIGNAL_URL, AUTH_KEY, process.env.ROOM);
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

/**
 * Resolve the send target from the peer list.
 * - EXACT name wins (fixes footgun F1: old code took the first SUBSTRING match,
 *   so `--to p2p-oracle` could silently grab `p2p-oracle-test`).
 * - substring only as a fallback, and only when UNAMBIGUOUS.
 * - the old `includes("receiver")||includes("m5")` default is gone (footgun F2:
 *   after the rename it matched `no1-receiver` and mis-sent there silently).
 * Returns the peer, or null after logging why (caller FAILs LOUD).
 */
function resolveTarget(peers: SignalingPeer[]): SignalingPeer | null {
  const want = targetName || DEFAULT_PEER;
  const others = peers.filter(p => p.id !== myId);
  const exact = others.filter(p => p.name === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    log(`AMBIGUOUS: ${exact.length} peers named exactly "${want}" (${exact.map(p => p.id.slice(0, 8)).join(", ")}) — refusing to guess`);
    return null;
  }
  const subs = others.filter(p => p.name.includes(want));
  if (subs.length === 1) { log(`(substring match "${want}" → "${subs[0].name}")`); return subs[0]; }
  if (subs.length > 1) {
    log(`AMBIGUOUS: "${want}" matches ${subs.map(p => p.name).join(", ")} — use an exact --to name`);
    return null;
  }
  log(`No peer matching "${want}" online (${targetName ? "--to" : "default"})`);
  log(`Online: ${others.map(p => p.name).join(", ") || "none"}`);
  return null;
}

// #104: resolved when the receiver confirms the full file landed (file-received ack)
const pendingAcks = new Map<string, (ack: { size: number; ok: boolean }) => void>();

async function sendFile(path: string): Promise<boolean> {
  if (!dc) return false;
  const name = basename(path);
  const data = readFileSync(path);
  const size = data.byteLength;

  log(`Sending: ${name} (${formatSize(size)})`);

  const fileId = Math.random().toString(36).slice(2, 10);
  dc.send(JSON.stringify({ type: "file-start", id: fileId, name, size }));

  let offset = 0;
  // hardening: the backpressure loop hangs FOREVER if the channel dies mid-transfer
  // (buffered bytes never drain) — track progress and bail after DRAIN_TIMEOUT_MS of stall
  let lastBuffered = Number.POSITIVE_INFINITY;
  let stallSince = Date.now();
  while (offset < size) {
    const end = Math.min(offset + CHUNK_SIZE, size);
    const chunk = data.subarray(offset, end);

    while (dc.bufferedAmount > 1024 * 1024) {
      if (dc.readyState !== "open") {
        process.stdout.write("\n");
        log(`CHANNEL ${dc.readyState}: ${name} — died at ${formatSize(offset)}/${formatSize(size)}; treating as failed`);
        return false;
      }
      if (dc.bufferedAmount < lastBuffered) {
        lastBuffered = dc.bufferedAmount;
        stallSince = Date.now();
      } else if (Date.now() - stallSince > DRAIN_TIMEOUT_MS) {
        process.stdout.write("\n");
        log(`STALL: ${name} — no progress for ${DRAIN_TIMEOUT_MS / 1000}s at ${formatSize(offset)}/${formatSize(size)}; treating as failed`);
        return false;
      }
      await new Promise(r => setTimeout(r, 10));
    }
    lastBuffered = Number.POSITIVE_INFINITY;

    dc.send(chunk);
    offset = end;
    const pct = ((offset / size) * 100).toFixed(0);
    process.stdout.write(`\r  ${pct}% (${formatSize(offset)} / ${formatSize(size)})`);
  }

  // #104: everything below used to be `send(file-end); log("Sent"); exit 500ms later`
  // — which dropped up to 1 MB of SCTP-buffered data and lied about delivery.
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (dc.bufferedAmount > 0) {
    if (Date.now() > drainDeadline) {
      process.stdout.write("\n");
      log(`DRAIN TIMEOUT: ${name} — ${formatSize(dc.bufferedAmount)} still buffered after ${DRAIN_TIMEOUT_MS / 1000}s, channel likely dead`);
      return false;
    }
    await new Promise(r => setTimeout(r, 10));
  }

  const ackPromise = new Promise<{ size: number; ok: boolean } | null>((resolveAck) => {
    const timer = setTimeout(() => { pendingAcks.delete(fileId); resolveAck(null); }, ACK_TIMEOUT_MS);
    pendingAcks.set(fileId, (ack) => { clearTimeout(timer); pendingAcks.delete(fileId); resolveAck(ack); });
  });

  dc.send(JSON.stringify({ type: "file-end", id: fileId, size }));
  process.stdout.write("\n");

  const ack = await ackPromise;
  if (!ack) {
    log(`NO ACK for ${name} after ${ACK_TIMEOUT_MS / 1000}s — delivery NOT confirmed, treating as failed`);
    return false;
  }
  if (!ack.ok || ack.size !== size) {
    log(`INCOMPLETE: ${name} — receiver got ${formatSize(ack.size)} of ${formatSize(size)}`);
    return false;
  }
  log(`Delivered: ${name} (${formatSize(size)} confirmed by receiver)`);
  return true;
}

async function run() {
  if (!listPeers) {
    for (const f of filePaths) {
      try { statSync(f); } catch {
        log(`File not found: ${f}`);
        process.exit(1);
      }
    }
  }

  log(`Connecting to signaling...`);
  ws = new WebSocket(signalingUrl());
  connectionTimer = setTimeout(() => {
    log(`CONNECTION TIMEOUT after ${CONNECT_TIMEOUT_MS / 1000}s — signaling or P2P channel did not become ready`);
    try { ws.close(); } catch {}
    try { pc?.close(); } catch {}
    process.exit(2);
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "identify", name: PEER_NAME }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(String(event.data));

    switch (msg.type) {
      case "error":
        if (msg.code === "ID-TAKEN") {
          log("ID-TAKEN: peer name already registered in this room; choose a different PEER_NAME");
          process.exit(1);
        }
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "welcome":
        myId = msg.id;
        log(`Connected as "${PEER_NAME}" (${msg.peers} peers online)`);
        ws.send(JSON.stringify({ type: "list-peers" }));
        break;

      case "peer-list": {
        const peers = msg.peers as SignalingPeer[];

        if (listPeers) {
          if (connectionTimer) clearTimeout(connectionTimer);
          console.log(`\n  Online peers (${peers.length}):\n`);
          for (const p of peers) {
            const me = p.id === myId ? " (you)" : "";
            const isRecv = p.name.includes("receiver") ? " ← receiver" : "";
            console.log(`    ${p.name.padEnd(30)} ${p.id.slice(0, 8)}${me}${isRecv}`);
          }
          console.log("");
          process.exit(0);
        }

        const target = resolveTarget(peers);
        if (!target) process.exit(1);   // FAIL LOUD — resolveTarget already logged why
        receiverId = target.id;
        log(`Found target: ${target.name} (${receiverId.slice(0, 8)})`);
        initP2P();
        break;
      }

      case "answer":
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp.sdp, msg.sdp.type));
        }
        break;

      case "ice-candidate":
        if (pc && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
        break;
    }
  };

  ws.onerror = () => { log("Signaling error"); process.exit(1); };
  ws.onclose = () => { if (!connected) { log("Signaling closed"); process.exit(1); } };
}

function initP2P() {
  pc = new RTCPeerConnection({
    iceServers: configuredIceServers(),
    // smoke test: ICE_RELAY_ONLY=1 forces TURN-relay-only candidates (prove relay works)
    ...(process.env.ICE_RELAY_ONLY === "1" ? { iceTransportPolicy: "relay" as const } : {}),
  });

  pc.onIceCandidate.subscribe((candidate) => {
    ws.send(JSON.stringify({ type: "ice-candidate", target: receiverId, candidate: candidate.toJSON() }));
  });

  dc = pc.createDataChannel("files", { ordered: true });

  // #104: receiver replies file-received {id, size, ok} after flushing + ledger write
  dc.onMessage.subscribe((data: Buffer | string) => {
    const str = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    if (!str.startsWith("{")) return;
    try {
      const msg = JSON.parse(str);
      if (msg.type === "file-received") pendingAcks.get(msg.id)?.({ size: msg.size, ok: !!msg.ok });
    } catch {}
  });

  dc.stateChanged?.subscribe(async (state: string) => {
    if (state === "open") {
      connected = true;
      if (connectionTimer) clearTimeout(connectionTimer);
      log("P2P DataChannel open — sending files...");

      let ok = 0, fail = 0;
      for (const f of filePaths) {
        try {
          if (await sendFile(f)) ok++;
          else fail++;
        } catch (e) {
          log(`Error: ${f} — ${e}`);
          fail++;
        }
      }

      log(`Done: ${ok} delivered, ${fail} failed`);
      setTimeout(() => process.exit(fail > 0 ? 2 : 0), 500);
    }
  });

  pc.createOffer().then(async (offer) => {
    const gatheredOffer = await gatheredLocalDescription(pc!, offer);
    ws.send(JSON.stringify({ type: "offer", target: receiverId, sdp: gatheredOffer }));
    log("Offer sent to target");
  });
}

run();
