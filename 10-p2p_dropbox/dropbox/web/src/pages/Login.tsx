import { useState } from "react";
import { validateApiKey, type AppConfig } from "../lib/api";

interface Props { onConnect: (key: string, config: AppConfig) => void }

export default function Login({ onConnect }: Props) {
  const [keyInput, setKeyInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    const key = keyInput.trim();
    if (!key || loading) return;
    setLoading(true);
    setError("");
    try {
      const config = await validateApiKey(key);
      onConnect(key, config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100dvh", display: "flex", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.03, backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "32px 32px" }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "4rem", position: "relative", zIndex: 1 }}>
        <div style={{ maxWidth: 480 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "2rem" }}>
            <div style={{ width: 40, height: 40, borderRadius: "0.75rem", background: "linear-gradient(135deg, #2563eb, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" /><path d="M12 12v9" /><path d="m8 17 4 4 4-4" /></svg>
            </div>
            <span style={{ fontSize: "1.1rem", fontWeight: 600, color: "#f1f5f9" }}>P2P Dropbox</span>
          </div>
          <h1 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 700, color: "#f8fafc", lineHeight: 1.15, marginBottom: "1rem" }}>
            Send files directly<br />to your local receiver
          </h1>
          <p style={{ fontSize: "1rem", color: "#64748b", lineHeight: 1.6, maxWidth: 420 }}>
            WebRTC transfer with local signaling and an authenticated HTTP fallback. Files are saved in your configured Home Assistant share directory.
          </p>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 1 }}>
        <div style={{ width: "100%", maxWidth: 380, padding: "2.5rem", background: "rgba(15,23,42,.6)", border: "1px solid rgba(30,41,59,.5)", borderRadius: "1rem" }}>
          <h2 style={{ fontSize: "1.25rem", color: "#f1f5f9", marginBottom: ".375rem" }}>Connect</h2>
          <p style={{ fontSize: ".8rem", color: "#64748b", marginBottom: "1.75rem" }}>Enter the auth key configured for this add-on.</p>
          <label style={{ display: "block", fontSize: ".75rem", color: "#94a3b8", marginBottom: ".375rem" }}>Auth key</label>
          <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void handleConnect()} onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)} autoComplete="current-password" autoFocus style={{ width: "100%", padding: ".75rem 1rem", background: "#0f172a", border: `1px solid ${inputFocused ? "#3b82f6" : "#1e293b"}`, borderRadius: ".5rem", color: "#e2e8f0" }} />
          {error && <p role="alert" style={{ color: "#f87171", fontSize: ".75rem", marginTop: ".75rem" }}>{error}</p>}
          <button onClick={() => void handleConnect()} disabled={loading || !keyInput.trim()} style={{ width: "100%", marginTop: "1rem", padding: ".75rem", background: "linear-gradient(135deg,#2563eb,#1d4ed8)", color: "white", border: "none", borderRadius: ".5rem", cursor: "pointer", opacity: loading || !keyInput.trim() ? .6 : 1 }}>
            {loading ? "Checking…" : "Connect"}
          </button>
          <p style={{ fontSize: ".7rem", color: "#475569", marginTop: "1.25rem", textAlign: "center" }}>The key stays in this browser tab session.</p>
        </div>
      </div>
    </div>
  );
}
