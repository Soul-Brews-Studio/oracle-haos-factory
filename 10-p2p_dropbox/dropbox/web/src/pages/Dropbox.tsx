import { useState, useEffect, useRef, useCallback } from "react";
import { SignalingClient, type SignalingEvent } from "../lib/signaling";
import { listFiles, uploadFile, downloadFile, signalingWsUrl, fetchPreview, getApiKey, getPeerName, setPeerName, validateApiKey, type AppConfig, type PreviewData, type FileEntry } from "../lib/api";
import { generatePeerName, type PeerInfo } from "../lib/types";
import { findUniqueReceiver } from "../lib/routing";
import DebugPanel, { type DebugEntry } from "./DebugPanel";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const TEXT_EXT = /\.(txt|md|py|ts|tsx|js|jsx|json|csv|toml|ya?ml|sh|bash|zsh|html|css|sql|log|rs|go|java|rb|php|c|h|cpp|hpp|swift|kt)$/i;

function fileIcon(name: string) {
  if (IMAGE_EXT.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (TEXT_EXT.test(name)) return "code";
  return "file";
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" });
}

const STATUS_STYLES = {
  online: { color: "#10b981", bg: "#052e1c", label: "Online", dot: "#10b981" },
  connecting: { color: "#f59e0b", bg: "#1c1506", label: "Connecting...", dot: "#f59e0b" },
  p2p: { color: "#818cf8", bg: "#1a1744", label: "P2P Ready", dot: "#818cf8" },
  failed: { color: "#ef4444", bg: "#1c0a0a", label: "Failed", dot: "#ef4444" },
} as const;

interface Props { config: AppConfig; onAuthFailed: () => void }

export default function Dropbox({ config, onAuthFailed }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [filterSender, setFilterSender] = useState<string>("");
  const [sortBy, setSortBy] = useState<"date" | "size" | "name">("date");
  const [status, setStatus] = useState<"disconnected" | "signaling" | "p2p">("disconnected");
  const [peerCount, setPeerCount] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [dragover, setDragover] = useState(false);
  const [sendingFile, setSendingFile] = useState<string | null>(null);
  const [transferMode, setTransferMode] = useState<"p2p" | "http">("p2p");
  const [preview, setPreview] = useState<{ name: string; data: PreviewData } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [myPeerName, setMyPeerName] = useState(() => getPeerName() || generatePeerName("web"));
  const [editingName, setEditingName] = useState(false);
  const [peerList, setPeerList] = useState<PeerInfo[]>([]);
  const [targetPeerId, setTargetPeerId] = useState<string | null>(null);
  const clientRef = useRef<SignalingClient | null>(null);

  const targetPeer = peerList.find(p => p.id === targetPeerId);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 50));
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await listFiles();
      setFiles(res.files);
      setSenders(res.senders);
    } catch {
      // Keep the last successful listing during a transient refresh failure.
    }
  }, []);

  useEffect(() => {
    if (status !== "p2p") return;
    const id = setInterval(refreshFiles, 5000);
    return () => clearInterval(id);
  }, [status, refreshFiles]);

  const receiverPeerName = config.receiver_peer_name || "p2p-dropbox";
  const httpMaxFileMb = config.http_max_file_mb ?? Math.min(config.max_file_mb, 32);

  // The add-on receiver is the only automatic target. Other peers require an
  // explicit click, so a drop can never go to the first arbitrary connection.
  useEffect(() => {
    if (targetPeerId && peerList.some((peer) => peer.id === targetPeerId)) return;
    const match = findUniqueReceiver(peerList, receiverPeerName);
    setTargetPeerId(match?.id || null);
    if (match?.status === "online") {
      clientRef.current?.connectToPeer(match.id);
    }
  }, [peerList, receiverPeerName, targetPeerId]);

  useEffect(() => {
    refreshFiles();
    if (!config.signal_token) {
      addLog("Signaling unavailable: server did not provide a scoped token");
      return;
    }
    const client = new SignalingClient(signalingWsUrl(config.signal_token, config.room), (e: SignalingEvent) => {
      switch (e.type) {
        case "connected": setStatus("signaling"); break;
        case "disconnected": setStatus("disconnected"); break;
        case "auth-failed": {
          onAuthFailed();
          break;
        }
        case "peer-joined": setPeerCount(e.total); break;
        case "peer-left": setPeerCount(e.total); break;
        case "p2p-open": setStatus("p2p"); break;
        case "p2p-closed": if (!client.hasP2P()) setStatus("signaling"); break;
        case "peers-updated": setPeerList(e.peers.filter((peer) => peer.name === receiverPeerName)); break;
        case "file-receiving": setProgress((e.received / e.size) * 100); break;
        case "file-received": {
          setProgress(null);
          const url = URL.createObjectURL(e.blob);
          const a = document.createElement("a"); a.href = url; a.download = e.name; a.click();
          URL.revokeObjectURL(url); refreshFiles(); break;
        }
        case "log": addLog(e.msg); break;
        case "debug":
          setDebugEntries((prev) => [...prev, {
            ts: new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions),
            category: e.category,
            direction: e.direction,
            msg: e.msg,
          }].slice(-500));
          break;
      }
    }, myPeerName, config.iceServers, receiverPeerName, async () => {
      const fresh = await validateApiKey(getApiKey());
      if (!fresh.signal_token) throw new Error("Server did not provide a scoped signaling token");
      return signalingWsUrl(fresh.signal_token, fresh.room);
    });
    client.connect();
    clientRef.current = client;
    return () => client.disconnect();
  }, [addLog, config.room, config.iceServers, config.signal_token, myPeerName, onAuthFailed, receiverPeerName, refreshFiles]);

  const handleSelectPeer = useCallback((peerId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setTargetPeerId(peerId);
    const peer = peerList.find(p => p.id === peerId);
    if (peer && peer.status === "online") {
      client.connectToPeer(peerId);
      addLog(`Connecting P2P to ${peer.name}...`);
    }
  }, [peerList, addLog]);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const client = clientRef.current;

    for (const file of Array.from(fileList)) {
      if (file.size > config.max_file_mb * 1024 * 1024) {
        addLog(`Rejected: ${file.name} exceeds ${config.max_file_mb} MB limit`);
        continue;
      }
      const p2pClient = targetPeerId && client?.hasP2PWith(targetPeerId) ? client : null;
      if (!p2pClient && file.size > httpMaxFileMb * 1024 * 1024) {
        addLog(`${file.name} requires P2P; HTTP fallback max ${httpMaxFileMb} MiB`);
        continue;
      }
      if (p2pClient && targetPeerId) {
        const peerName = peerList.find(p => p.id === targetPeerId)?.name || "peer";
        setSendingFile(file.name);
        setTransferMode("p2p");
        setProgress(0);
        addLog(`P2P → ${peerName}: ${file.name} (${formatSize(file.size)})`);
        try {
          const ok = await p2pClient.sendFileToPeer(targetPeerId, file, setProgress);
          if (ok) addLog(`Delivered to ${peerName}: ${file.name}`);
          else addLog(`Failed: ${file.name} — channel not open`);
        } catch (err: unknown) {
          const e = err as Error;
          addLog(`Error: ${file.name} — ${e?.message || String(err)}`);
        }
        setProgress(null);
        setSendingFile(null);
      } else {
        setSendingFile(file.name);
        setTransferMode("http");
        setProgress(0);
        addLog(`HTTP fallback → ${file.name} (${formatSize(file.size)})`);
        try {
          await uploadFile(file, setProgress);
          addLog(`HTTP upload saved: ${file.name}`);
        } catch (err) {
          addLog(`HTTP upload failed: ${file.name} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setProgress(null);
      setSendingFile(null);
      refreshFiles();
    }
  }, [addLog, config.max_file_mb, httpMaxFileMb, refreshFiles, targetPeerId, peerList]);

  const closePreview = useCallback(() => {
    if (preview?.data.type === "image" || preview?.data.type === "pdf") URL.revokeObjectURL(preview.data.url);
    setPreview(null);
  }, [preview]);

  const openPreview = useCallback(async (name: string) => {
    setPreviewLoading(true);
    try {
      const data = await fetchPreview(name);
      setPreview({ name, data });
    } catch {
      addLog(`Preview failed: ${name}`);
    }
    setPreviewLoading(false);
  }, [addLog]);

  const filteredFiles = filterSender ? files.filter(f => f.sender === filterSender) : files;
  const sortedFiles = [...filteredFiles].sort((a, b) => {
    if (sortBy === "size") return b.size - a.size;
    if (sortBy === "name") return a.name.localeCompare(b.name);
    return b.modified.localeCompare(a.modified);
  });

  const statusConfig = {
    disconnected: { color: "#ef4444", bg: "#1c0a0a", label: "Disconnected", dot: "#ef4444" },
    signaling: { color: "#10b981", bg: "#052e1c", label: "Signaling", dot: "#10b981" },
    p2p: { color: "#818cf8", bg: "#1a1744", label: "P2P Connected", dot: "#818cf8" },
  }[status];

  const canSendToTarget = targetPeerId && targetPeer?.status === "p2p";
  const dropLabel = targetPeer
    ? canSendToTarget
      ? `Drop files to send to ${targetPeer.name}`
      : `Connecting to ${targetPeer.name}...`
    : peerList.length > 0
      ? "Select a peer below, then drop files"
      : "No receiver connected — drops use authenticated HTTP fallback";

  return (
    <div>
      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.625rem 1rem", borderRadius: "0.5rem", marginBottom: "1.25rem", background: statusConfig.bg, border: `1px solid ${statusConfig.color}22` }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusConfig.dot, boxShadow: `0 0 6px ${statusConfig.dot}` }} />
        <span style={{ fontSize: "0.8rem", color: statusConfig.color, fontWeight: 500 }}>{statusConfig.label}</span>
        {peerCount > 1 && <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{peerCount} peers online</span>}
        <span style={{ marginLeft: "auto" }} />
        {editingName ? (
          <input
            autoFocus
            defaultValue={myPeerName}
            onBlur={(e) => { const v = e.target.value.trim() || "dustboy-phd"; setMyPeerName(v); setPeerName(v); setEditingName(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            style={{ fontSize: "0.7rem", color: "#818cf8", background: "#1a1744", border: "1px solid #818cf833", borderRadius: "0.25rem", padding: "0.125rem 0.375rem", width: 140, outline: "none", fontFamily: "monospace" }}
          />
        ) : (
          <span
            onClick={() => setEditingName(true)}
            style={{ fontSize: "0.7rem", color: "#64748b", cursor: "pointer", fontFamily: "monospace", padding: "0.125rem 0.375rem", borderRadius: "0.25rem", border: "1px solid transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#1e293b"; e.currentTarget.style.color = "#818cf8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "#64748b"; }}
            title="Click to edit peer name"
          >
            {myPeerName}
          </span>
        )}
      </div>

      {/* Peer directory */}
      {peerList.length > 0 && (
        <div style={{ marginBottom: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <h3 style={{ fontSize: "0.8rem", fontWeight: 500, color: "#94a3b8", margin: 0 }}>Send to</h3>
            <span style={{ fontSize: "0.65rem", color: "#475569" }}>{peerList.length} peer{peerList.length !== 1 ? "s" : ""}</span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {peerList.map((peer) => {
              const s = STATUS_STYLES[peer.status];
              const selected = peer.id === targetPeerId;
              return (
                <button
                  key={peer.id}
                  onClick={() => handleSelectPeer(peer.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: "0.5rem",
                    padding: "0.5rem 0.875rem",
                    background: selected ? s.bg : "#0a0f1a",
                    border: `1.5px solid ${selected ? s.color : "#1e293b"}`,
                    borderRadius: "0.5rem",
                    cursor: "pointer",
                    transition: "all 0.15s",
                    outline: "none",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.borderColor = "#334155"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.borderColor = "#1e293b"; }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: s.dot,
                    boxShadow: selected ? `0 0 8px ${s.dot}` : "none",
                    flexShrink: 0,
                  }} />
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontSize: "0.78rem", color: selected ? "#e2e8f0" : "#94a3b8", fontWeight: selected ? 600 : 400, fontFamily: "monospace" }}>
                      {peer.name}
                    </div>
                    <div style={{ fontSize: "0.6rem", color: s.color, marginTop: "0.125rem" }}>
                      {s.label}
                    </div>
                  </div>
                  {selected && peer.status === "p2p" && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "0.25rem", flexShrink: 0 }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => { e.preventDefault(); setDragover(false); handleFiles(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${dragover ? (canSendToTarget ? "#818cf8" : "#f59e0b") : "#1e293b"}`,
          borderRadius: "0.75rem", padding: "2rem 1.5rem", textAlign: "center",
          marginBottom: "1.5rem",
          background: dragover ? (canSendToTarget ? "#1a1744" : "#1c1506") : "#0a0f1a",
          transition: "all 0.2s",
        }}
      >
        {sendingFile ? (
          <>
            <p style={{ fontSize: "0.8rem", color: "#818cf8", margin: "0 0 0.25rem", fontWeight: 500 }}>
              {transferMode === "p2p" ? "Sending via WebRTC DataChannel" : "Uploading via HTTP fallback"}
            </p>
            <p style={{ fontSize: "0.7rem", color: "#64748b", margin: "0 0 0.75rem", wordBreak: "break-all" }}>
              {sendingFile} {targetPeer ? `→ ${targetPeer.name}` : ""}
            </p>
            {progress !== null && (
              <div>
                <div style={{ width: "100%", height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progress}%`, background: "#818cf8", transition: "width 0.15s", borderRadius: 3 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.375rem" }}>
                  <span style={{ fontSize: "0.65rem", color: "#818cf8", fontFamily: "monospace" }}>{progress.toFixed(1)}%</span>
                  <span style={{ fontSize: "0.65rem", color: "#475569", fontFamily: "monospace" }}>
                    {transferMode === "p2p" ? `P2P → ${targetPeer?.name || "receiver"}` : "HTTP → configured save directory"}
                  </span>
                </div>
              </div>
            )}
            <div style={{ marginTop: "0.75rem", textAlign: "left" }}>
              <button
                onClick={() => setShowDebug(!showDebug)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "0.375rem",
                  padding: "0.2rem 0.5rem", borderRadius: "0.25rem",
                  border: `1px solid ${showDebug ? "#818cf833" : "#1e293b"}`,
                  background: showDebug ? "#1a1744" : "transparent",
                  color: showDebug ? "#818cf8" : "#475569",
                  cursor: "pointer", fontSize: "0.6rem", fontWeight: 500,
                }}
              >
                {showDebug ? "▾" : "▸"} WebRTC Debug ({debugEntries.length})
              </button>
              {showDebug && (
                <div style={{ marginTop: "0.5rem" }} onClick={(e) => e.stopPropagation()}>
                  <DebugPanel entries={debugEntries} />
                </div>
              )}
            </div>
            <p style={{ fontSize: "0.6rem", color: "#334155", marginTop: "0.5rem" }}>
              Drop more files to queue
            </p>
          </>
        ) : (
          <>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={dragover ? "#818cf8" : "#334155"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "0.5rem" }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p style={{ fontSize: "0.85rem", color: dragover ? "#818cf8" : "#94a3b8", margin: "0 0 0.25rem" }}>
              {canSendToTarget ? "Drop files here" : "Drag & drop files here"}
            </p>
            <p style={{ fontSize: "0.7rem", color: "#475569", margin: 0 }}>
              {dropLabel}
            </p>
            <p style={{ fontSize: "0.65rem", color: "#334155", margin: "0.35rem 0 0" }}>
              HTTP fallback limit: {httpMaxFileMb} MiB; larger files require P2P
            </p>
          </>
        )}
      </div>

      {/* File list header + filters */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h3 style={{ fontSize: "0.85rem", fontWeight: 500, color: "#94a3b8", margin: 0 }}>Files ({filteredFiles.length}{filterSender ? ` / ${files.length}` : ""})</h3>
        <div style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
          {senders.length > 0 && (
            <select
              value={filterSender}
              onChange={(e) => setFilterSender(e.target.value)}
              style={{ fontSize: "0.7rem", background: "#0a0f1a", color: "#94a3b8", border: "1px solid #1e293b", borderRadius: "0.25rem", padding: "0.2rem 0.375rem", cursor: "pointer" }}
            >
              <option value="">All senders</option>
              {senders.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "date" | "size" | "name")}
            style={{ fontSize: "0.7rem", background: "#0a0f1a", color: "#94a3b8", border: "1px solid #1e293b", borderRadius: "0.25rem", padding: "0.2rem 0.375rem", cursor: "pointer" }}
          >
            <option value="date">Sort: Date</option>
            <option value="size">Sort: Size</option>
            <option value="name">Sort: Name</option>
          </select>
          <button onClick={refreshFiles} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "0.7rem", padding: "0.2rem 0.375rem" }}>
            Refresh
          </button>
        </div>
      </div>
      {sortedFiles.length === 0 ? (
        <div style={{ padding: "3rem", textAlign: "center", color: "#334155", fontSize: "0.875rem", background: "#0a0f1a", borderRadius: "0.5rem", border: "1px solid #111827" }}>
          {files.length === 0 ? "No files uploaded yet" : `No files from "${filterSender}"`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {Object.entries(
            sortedFiles.reduce<Record<string, FileEntry[]>>((acc, f) => {
              const d = f.date || "undated";
              (acc[d] ??= []).push(f);
              return acc;
            }, {})
          ).sort(([a], [b]) => b.localeCompare(a)).map(([date, group]) => (
            <div key={date}>
              <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "#475569", marginBottom: "0.375rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {date === "undated" ? "Undated" : date} ({group.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {group.map((f) => {
                  const kind = fileIcon(f.name);
                  return (
                    <div key={`${f.date}/${f.name}`}
                      onClick={() => openPreview(f.name)}
                      style={{ display: "flex", alignItems: "center", padding: "0.5rem 0.75rem", background: "#0a0f1a", border: "1px solid #111827", borderRadius: "0.375rem", transition: "border-color 0.15s", cursor: "pointer" }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#1e293b")}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#111827")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={kind === "code" ? "#818cf8" : kind === "pdf" ? "#f87171" : "#475569"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginRight: "0.625rem" }}>
                          {kind === "code" ? (
                            <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>
                          ) : kind === "pdf" ? (
                            <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>
                          ) : (
                            <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
                          )}
                      </svg>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "0.78rem", color: "#cbd5e1", wordBreak: "break-all" }}>{f.name}</div>
                        <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.6rem", color: "#475569", marginTop: "0.125rem" }}>
                          {f.sender && <span style={{ color: "#818cf8" }}>{f.sender}</span>}
                          <span>{timeAgo(f.modified)}</span>
                        </div>
                      </div>
                      <span style={{ fontSize: "0.7rem", color: "#475569", marginLeft: "0.75rem", whiteSpace: "nowrap" }}>{formatSize(f.size)}</span>
                      <button type="button" aria-label={`Download ${f.name}`} onClick={(e) => { e.stopPropagation(); void downloadFile(f.name).catch(() => addLog(`Download failed: ${f.name}`)); }} style={{ marginLeft: "0.625rem", color: "#475569", transition: "color 0.15s", flexShrink: 0, background: "none", border: 0, cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#60a5fa")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Activity log */}
      {logs.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ fontSize: "0.8rem", fontWeight: 500, color: "#334155", marginBottom: "0.5rem" }}>Activity</h3>
          <div style={{ maxHeight: 160, overflowY: "auto", fontSize: "0.75rem", color: "#475569" }}>
            {logs.map((l, i) => (
              <div key={i} style={{ padding: "0.25rem 0", borderBottom: "1px solid #0f172a" }}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          onClick={closePreview}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "2rem" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "0.75rem", maxWidth: 800, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1rem", borderBottom: "1px solid #1e293b" }}>
              <span style={{ fontSize: "0.85rem", color: "#cbd5e1", fontWeight: 500, wordBreak: "break-all" }}>{preview.name}</span>
              <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0, marginLeft: "1rem" }}>
                <button onClick={() => void downloadFile(preview.name).catch(() => addLog(`Download failed: ${preview.name}`))} style={{ color: "#60a5fa", fontSize: "0.75rem", background: "none", border: 0, cursor: "pointer" }}>Download</button>
                <button onClick={closePreview} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, padding: "0 0.25rem" }}>×</button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{ overflow: "auto", flex: 1, padding: preview.data.type === "text" ? 0 : "1rem" }}>
              {preview.data.type === "image" && (
                <img src={preview.data.url} alt={preview.name} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto", borderRadius: 4 }} />
              )}
              {preview.data.type === "pdf" && (
                <iframe src={preview.data.url} style={{ width: "100%", height: "70vh", border: "none", borderRadius: 4 }} />
              )}
              {preview.data.type === "text" && (
                <div style={{ position: "relative" }}>
                  <pre style={{ margin: 0, padding: "1rem", fontSize: "0.75rem", lineHeight: 1.6, color: "#94a3b8", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", tabSize: 2 }}>
                    {preview.data.content}
                  </pre>
                  {preview.data.truncated && (
                    <div style={{ padding: "0.5rem 1rem", borderTop: "1px solid #1e293b", fontSize: "0.7rem", color: "#475569", textAlign: "center" }}>
                      Showing {preview.data.lines} of {preview.data.totalLines} lines
                    </div>
                  )}
                </div>
              )}
              {preview.data.type === "binary" && (
                <div style={{ textAlign: "center", padding: "3rem", color: "#475569" }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "1rem" }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                  </svg>
                  <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>Binary file</p>
                  <p style={{ fontSize: "0.75rem", color: "#334155" }}>{formatSize(preview.data.size)}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Preview loading overlay */}
      {previewLoading && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>Loading preview...</div>
        </div>
      )}
    </div>
  );
}
