import { useEffect, useState } from "react";
import { applyTheme, persistTheme, storedTheme, type ThemeMode } from "../theme";

const next: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") return <svg aria-hidden="true" viewBox="0 0 24 24" className="theme-icon">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </svg>;
  if (mode === "dark") return <svg aria-hidden="true" viewBox="0 0 24 24" className="theme-icon">
    <path d="M20.5 15.2A8.6 8.6 0 0 1 8.8 3.5 8.7 8.7 0 1 0 20.5 15.2Z" />
  </svg>;
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="theme-icon">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" className="theme-icon-fill" />
  </svg>;
}

export default function ThemeSwitcher() {
  const [mode, setMode] = useState<ThemeMode>(storedTheme);

  useEffect(() => {
    applyTheme(mode);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => { if (mode === "system") applyTheme("system"); };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [mode]);

  const cycle = () => {
    const value = next[mode];
    persistTheme(value);
    setMode(value);
  };

  return <button type="button" onClick={cycle}
    className="theme-switcher" aria-label={`Theme: ${mode}. Activate for ${next[mode]} theme.`}
    title={`Theme: ${mode} · next: ${next[mode]}`}>
    <ThemeIcon mode={mode} />
    <span className="hidden md:inline capitalize">{mode}</span>
  </button>;
}
