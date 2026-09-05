import { useEffect, useState } from "react";
import ApiDocs from "./pages/ApiDocs";
import Bots from "./pages/Bots";
import Chat from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import History from "./pages/History";
import Media from "./pages/Media";
import Settings from "./pages/Settings";
import Today from "./pages/Today";
import Vectors from "./pages/Vectors";

export default function App() {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const syncPath = () => setPath(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", syncPath);
    return () => window.removeEventListener("hashchange", syncPath);
  }, []);
  useEffect(() => {
    if (!window.location.hash) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }));
  }, [path]);
  if (path === "/today") return <Today />;
  if (path === "/chat") return <Chat />;
  if (path.startsWith("/history")) return <History />;
  if (path === "/media") return <Media />;
  if (path === "/vectors") return <Vectors />;
  if (path === "/bots") return <Bots />;
  if (path === "/settings") return <Settings />;
  if (path === "/api-docs") return <ApiDocs />;
  return <Dashboard />;
}
