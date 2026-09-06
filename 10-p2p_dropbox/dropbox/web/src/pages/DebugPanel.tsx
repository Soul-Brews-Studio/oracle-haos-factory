import { useRef, useEffect } from "react";
import type { DebugCategory } from "../lib/signaling";

interface DebugEntry {
  ts: string;
  category: DebugCategory;
  direction: "out" | "in" | "info";
  msg: string;
}

const CATEGORY_COLORS: Record<DebugCategory, string> = {
  ws: "#10b981",
  ice: "#f59e0b",
  sdp: "#818cf8",
  dc: "#3b82f6",
  file: "#ec4899",
};

const CATEGORY_LABELS: Record<DebugCategory, string> = {
  ws: "WS",
  ice: "ICE",
  sdp: "SDP",
  dc: "DC",
  file: "FILE",
};

const DIR_SYMBOLS: Record<string, string> = {
  out: "▲",
  in: "▼",
  info: "●",
};

const DIR_COLORS: Record<string, string> = {
  out: "#60a5fa",
  in: "#34d399",
  info: "#94a3b8",
};

export default function DebugPanel({ entries }: { entries: DebugEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div style={{
      background: "#020617",
      border: "1px solid #1e293b",
      borderRadius: "0.5rem",
      marginTop: "1rem",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.5rem 0.75rem",
        borderBottom: "1px solid #1e293b",
        background: "#0f172a",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            WebRTC Debug
          </span>
          <span style={{ fontSize: "0.6rem", color: "#334155" }}>
            {entries.length} events
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <span key={key} style={{
              fontSize: "0.55rem",
              fontWeight: 600,
              color: CATEGORY_COLORS[key as DebugCategory],
              background: `${CATEGORY_COLORS[key as DebugCategory]}15`,
              padding: "1px 5px",
              borderRadius: "3px",
            }}>
              {label}
            </span>
          ))}
        </div>
      </div>

      <div ref={scrollRef} style={{
        maxHeight: 300,
        overflowY: "auto",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: "0.65rem",
        lineHeight: 1.7,
        padding: "0.375rem 0",
      }}>
        {entries.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#334155" }}>
            Waiting for WebRTC events...
          </div>
        ) : (
          entries.map((e, i) => (
            <div key={i} style={{
              display: "flex",
              padding: "0 0.75rem",
              gap: "0.5rem",
              alignItems: "flex-start",
              borderLeft: `2px solid ${CATEGORY_COLORS[e.category]}`,
              marginLeft: "0.375rem",
            }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "#0f172a")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: "#334155", flexShrink: 0 }}>{e.ts}</span>
              <span style={{
                color: CATEGORY_COLORS[e.category],
                fontWeight: 600,
                width: 30,
                flexShrink: 0,
                textAlign: "center",
              }}>
                {CATEGORY_LABELS[e.category]}
              </span>
              <span style={{ color: DIR_COLORS[e.direction], flexShrink: 0, width: 10 }}>
                {DIR_SYMBOLS[e.direction]}
              </span>
              <span style={{ color: "#94a3b8", wordBreak: "break-all" }}>{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export type { DebugEntry };
