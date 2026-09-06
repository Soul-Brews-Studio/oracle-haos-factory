import { useEffect, useState } from "react";
import Login from "./pages/Login";
import Dropbox from "./pages/Dropbox";
import { getApiKey, setApiKey, validateApiKey, type AppConfig } from "./lib/api";

const GLOBAL_STYLES = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #050508; color: #e2e8f0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  ::selection { background: #2563eb40; }
  :focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  input:focus { outline: none; }
`;

export default function App() {
  const [key, setKey] = useState(getApiKey());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [checking, setChecking] = useState(Boolean(key));

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = GLOBAL_STYLES;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  useEffect(() => {
    if (!key) return;
    validateApiKey(key).then(setConfig).catch(() => {
      setApiKey("");
      setKey("");
    }).finally(() => setChecking(false));
  }, [key]);

  const handleConnect = (newKey: string, newConfig: AppConfig) => {
    setApiKey(newKey);
    setConfig(newConfig);
    setKey(newKey);
  };

  const handleLogout = () => {
    setApiKey("");
    setConfig(null);
    setKey("");
  };

  if (checking) {
    return <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "#64748b" }}>Connecting…</div>;
  }
  if (!key || !config) return <Login onConnect={handleConnect} />;

  return (
    <div style={{ minHeight: "100dvh" }}>
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(5,5,8,0.8)", backdropFilter: "blur(12px)", borderBottom: "1px solid #111827" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 1.5rem", height: 56, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
            <div style={{ width: 28, height: 28, borderRadius: "0.375rem", background: "linear-gradient(135deg, #1e40af, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242M12 12v9m-4-5 4 4 4-4" />
              </svg>
            </div>
            <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>P2P Dropbox</span>
          </div>
          <button onClick={handleLogout} style={{ padding: "0.375rem 0.75rem", border: "1px solid #1e293b", background: "transparent", color: "#64748b", cursor: "pointer", borderRadius: "0.375rem", fontSize: "0.75rem" }}>
            Disconnect
          </button>
        </div>
      </header>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem" }}>
        <Dropbox config={config} onAuthFailed={handleLogout} />
      </main>
    </div>
  );
}
