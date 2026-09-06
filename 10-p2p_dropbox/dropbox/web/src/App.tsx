import { useCallback, useEffect, useRef, useState } from "react";
import Login from "./pages/Login";
import Dropbox from "./pages/Dropbox";
import {
  bootstrapIngressAuth,
  clearIngressSession,
  getIngressSession,
  getManualApiKey,
  onAuthFailed,
  setApiKey,
  setIngressSession,
  validateApiKey,
  type AppConfig,
  type IngressAuthResult,
} from "./lib/api";

const GLOBAL_STYLES = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #050508; color: #e2e8f0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  ::selection { background: #2563eb40; }
  :focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  input:focus { outline: none; }
`;

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [checking, setChecking] = useState(true);
  const [denial, setDenial] = useState<IngressAuthResult | null>(null);
  const [sessionExpiry, setSessionExpiry] = useState<number | null>(null);
  const attemptRef = useRef(0);
  const ingressIdentityRef = useRef({ userId: "", userName: "" });

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = GLOBAL_STYLES;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  const connectThroughIngress = useCallback(async (allowManualFallback: boolean) => {
    const attempt = ++attemptRef.current;
    setChecking(true);
    try {
      const result = await bootstrapIngressAuth();
      if (attempt !== attemptRef.current) return;
      if (result.ok) {
        const session = setIngressSession(result);
        const nextConfig = await validateApiKey(session.token);
        if (attempt !== attemptRef.current) return;
        ingressIdentityRef.current = { userId: session.userId, userName: session.userName };
        setConfig(nextConfig);
        setSessionExpiry(session.expiresAt);
        setDenial(null);
        return;
      }

      clearIngressSession();
      setSessionExpiry(null);
      setDenial(result.ingress ? result : null);
      if (allowManualFallback) {
        const savedKey = getManualApiKey();
        if (savedKey) {
          const nextConfig = await validateApiKey(savedKey);
          if (attempt !== attemptRef.current) return;
          setConfig(nextConfig);
          setDenial(null);
          return;
        }
      }
      setConfig(null);
    } catch {
      if (attempt !== attemptRef.current) return;
      clearIngressSession();
      if (allowManualFallback) {
        const savedKey = getManualApiKey();
        if (savedKey) {
          try {
            const nextConfig = await validateApiKey(savedKey);
            if (attempt !== attemptRef.current) return;
            setConfig(nextConfig);
            return;
          } catch {
            setApiKey("");
          }
        }
      }
      const identity = ingressIdentityRef.current;
      if (!allowManualFallback && (identity.userId || identity.userName)) {
        setDenial({
          ok: false,
          ingress: true,
          error: "Home Assistant authorization could not be refreshed.",
          user_id: identity.userId,
          user_name: identity.userName,
          allowlistOption: "auto_login_ha_user_ids",
        });
      }
      setSessionExpiry(null);
      setConfig(null);
    } finally {
      if (attempt === attemptRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void connectThroughIngress(true);
    return () => { attemptRef.current += 1; };
  }, [connectThroughIngress]);

  useEffect(() => {
    if (!sessionExpiry || !getIngressSession()) return;
    const delay = Math.max(1_000, sessionExpiry * 1_000 - Date.now() - 60_000);
    const timer = window.setTimeout(() => void connectThroughIngress(false), delay);
    return () => window.clearTimeout(timer);
  }, [connectThroughIngress, sessionExpiry]);

  const handleAuthFailed = useCallback(() => {
    const session = getIngressSession();
    const identity = session
      ? { userId: session.userId, userName: session.userName }
      : ingressIdentityRef.current;
    attemptRef.current += 1;
    clearIngressSession();
    setSessionExpiry(null);
    setConfig(null);
    if (identity.userId || identity.userName) {
      setDenial({
        ok: false,
        ingress: true,
        error: "Your Home Assistant session is no longer authorized.",
        user_id: identity.userId,
        user_name: identity.userName,
        allowlistOption: "auto_login_ha_user_ids",
      });
    } else {
      setApiKey("");
      setDenial(null);
    }
    setChecking(false);
  }, []);

  useEffect(() => onAuthFailed(handleAuthFailed), [handleAuthFailed]);

  const handleConnect = (newKey: string, newConfig: AppConfig) => {
    attemptRef.current += 1;
    clearIngressSession();
    ingressIdentityRef.current = { userId: "", userName: "" };
    setApiKey(newKey);
    setConfig(newConfig);
    setSessionExpiry(null);
    setDenial(null);
  };

  const handleLogout = () => {
    attemptRef.current += 1;
    setApiKey("");
    clearIngressSession();
    ingressIdentityRef.current = { userId: "", userName: "" };
    setConfig(null);
    setSessionExpiry(null);
    setDenial(null);
    setChecking(false);
  };

  if (checking && !config) {
    return <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "#64748b" }}>Connecting…</div>;
  }
  if (!config) return (
    <Login
      onConnect={handleConnect}
      denial={denial}
      onConnectWithHomeAssistant={() => void connectThroughIngress(false)}
      homeAssistantLoading={checking}
    />
  );

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
        <Dropbox config={config} onAuthFailed={handleAuthFailed} />
      </main>
    </div>
  );
}
