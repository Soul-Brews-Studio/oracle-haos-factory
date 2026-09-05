import { useCallback, useEffect, useRef, useState } from "react";
import ThemeSwitcher from "./ThemeSwitcher";

const links = [
  ["/today", "Today"], ["/chat", "Chat"], ["/history", "History"],
  ["/media", "Media"], ["/vectors", "Vectors"], ["/bots", "Bots"],
  ["/settings", "Settings"], ["/api-docs", "API"],
];

function active(href: string, path: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export default function Nav() {
  const path = window.location.hash.slice(1) || "/";
  const activeLink = useRef<HTMLAnchorElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [scrollCues, setScrollCues] = useState({ left: false, right: false });
  const measureRail = useCallback(() => {
    const node = rail.current;
    if (!node) return;
    setScrollCues({
      left: node.scrollLeft > 2,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2,
    });
  }, []);
  useEffect(() => {
    activeLink.current?.scrollIntoView({ block: "nearest", inline: "center" });
    requestAnimationFrame(measureRail);
  }, [path, measureRail]);
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    measureRail();
    node.addEventListener("scroll", measureRail, { passive: true });
    window.addEventListener("resize", measureRail);
    return () => {
      node.removeEventListener("scroll", measureRail);
      window.removeEventListener("resize", measureRail);
    };
  }, [measureRail]);
  return <nav aria-label="Primary" className="border-b border-border bg-bg/95 sticky top-0 z-30 backdrop-blur">
    <div className="md:flex md:items-center md:px-6 md:min-w-0">
      <div className="h-12 px-4 md:h-auto md:px-0 flex items-center justify-between">
        <a href="#/" aria-label="LINE Lance status" className="brand-link">LINE Lance</a>
        <div className="flex items-center gap-2 shrink-0 md:hidden" aria-label="Display and connection status"><ThemeSwitcher /></div>
      </div>
      <div className="relative min-w-0 flex-1">
        <div ref={rail} className="h-11 md:h-auto min-w-0 flex items-center justify-start md:justify-center gap-x-3 md:gap-x-1 overflow-x-auto px-4 no-scrollbar">
        {links.map(([href, label]) => <a key={href} href={`#${href}`}
          ref={active(href, path) ? activeLink : undefined}
          aria-current={active(href, path) ? "page" : undefined}
          className={`nav-link ${active(href, path) ? "nav-link-active" : ""}`}>{label}</a>)}
        </div>
        {scrollCues.left && <span aria-hidden="true" className="nav-scroll-cue nav-scroll-cue-left pointer-events-none absolute left-0 top-0 h-11 w-7 md:hidden" />}
        {scrollCues.right && <span aria-hidden="true" className="nav-scroll-cue nav-scroll-cue-right pointer-events-none absolute right-0 top-0 h-11 w-7 md:hidden" />}
      </div>
      <div className="hidden md:flex items-center gap-2 shrink-0" aria-label="Display and connection status">
        <ThemeSwitcher />
        <span className="hidden lg:flex items-center gap-2 text-[11px] font-mono text-text-muted">
          <span className="status-dot" aria-hidden="true" /> local
        </span>
      </div>
    </div>
  </nav>;
}
