import type { ReactNode } from "react";
import Nav from "./Nav";

export default function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className="min-h-dvh flex flex-col bg-bg text-text">
    <button type="button" className="skip-link" onClick={() => document.querySelector<HTMLElement>("#main-content")?.focus()}>Skip to content</button>
    <Nav />
    <main id="main-content" tabIndex={-1} className={`${wide ? "max-w-[1500px]" : "max-w-6xl"} w-full flex-1 mx-auto px-4 md:px-6 py-8 md:py-9`}>{children}</main>
    <footer className="w-full max-w-6xl mx-auto px-4 md:px-6 py-7 md:py-8 flex flex-wrap justify-between gap-x-6 gap-y-2 text-[10px] font-mono text-text-muted border-t border-border">
      <span>Elysia · Python · LanceDB · React</span><span>local data, derived vectors</span>
    </footer>
  </div>;
}
