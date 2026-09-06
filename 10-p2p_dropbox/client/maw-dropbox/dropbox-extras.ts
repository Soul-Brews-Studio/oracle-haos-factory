#!/usr/bin/env bun
// maw-dropbox-extras v1 — optional decorator for lab03 dropbox v1.1.0.
// Reuses its config and sender; never reads server options or changes credentials.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Target { auth_key: string; http_url: string; ingress_url: string; signal_url: string; peer: string }
export interface FileRow { name: string; size: number; modified?: string; sender?: string }
export interface Stats { checked_at: string; files: number; bytes: number; mib: number; named_senders: number; latest: string | null }
export function summarize(value: unknown, now = new Date()): { stats: Stats; files: FileRow[] } {
  const data = value as { files?: unknown; senders?: unknown };
  if (!data || !Array.isArray(data.files) || !data.files.every(f => f && typeof f.name === "string" && Number.isSafeInteger(f.size) && f.size >= 0)) throw Error("Invalid Dropbox file listing");
  const files: FileRow[] = data.files;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(bytes)) throw Error("File byte total exceeds safe integer range");
  const senders = new Set([...(Array.isArray(data.senders) ? data.senders : []), ...files.map(f => f.sender)]
    .filter((s): s is string => typeof s === "string" && !!s.trim()));
  const dates = files.flatMap(f => typeof f.modified === "string" && Number.isFinite(Date.parse(f.modified)) ? [Date.parse(f.modified)] : []);
  return { files, stats: { checked_at: now.toISOString(), files: files.length, bytes,
    mib: Math.round(bytes / 1024 / 1024 * 100) / 100, named_senders: senders.size,
    latest: dates.length ? new Date(dates.reduce((a,b) => Math.max(a,b))).toISOString() : null } };
}
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
}
export function dashboardHtml(stats: Stats, files: FileRow[], ingress: string): string {
  const url = new URL(ingress);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error("Unsafe dashboard URL");
  const e = escapeHtml;
  const rows = files.map(f => `<tr><td>${e(f.name)}</td><td>${e(f.size.toLocaleString())}</td><td>${e(f.sender || "HTTP / unrecorded")}</td><td>${e(f.modified || "—")}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>P2P Dropbox · Statistics</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#080b12;color:#e6edf7}body{max-width:1100px;margin:auto;padding:36px 22px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:26px;margin:0}p,small{color:#93a3bd}a{color:#a5b4fc;text-decoration:none;border:1px solid #38456b;border-radius:9px;padding:10px 14px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.card{background:#121a2a;border:1px solid #27334c;border-radius:12px;padding:20px}.value{font-size:30px;font-weight:700;margin:7px 0}.table{overflow:auto;border:1px solid #27334c;border-radius:12px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:14px;border-bottom:1px solid #27334c}th{background:#121a2a;color:#a5b4fc}td:first-child{overflow-wrap:anywhere}footer{margin-top:24px;font-size:13px;color:#93a3bd}@media(max-width:650px){.cards{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}}
</style><header><div><h1>P2P Dropbox</h1><p>kvmlab1 · private file statistics</p></div><a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">Open HA dashboard ↗</a></header>
<div class="cards"><div class="card"><small>Stored files</small><div class="value">${e(stats.files)}</div></div><div class="card"><small>Total size</small><div class="value">${e(stats.mib)} MiB</div></div><div class="card"><small>Named senders</small><div class="value">${e(stats.named_senders)}</div></div><div class="card"><small>Snapshot checked</small><div>${e(stats.checked_at)}</div></div></div>
<p>Latest file: ${e(stats.latest || "No files yet")} · ${e(stats.bytes.toLocaleString())} bytes total</p>
<div class="table"><table><thead><tr><th>File</th><th>Bytes</th><th>Recorded sender</th><th>Modified</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No files yet</td></tr>'}</tbody></table></div>
<footer>Read-only snapshot, not an auto-refreshing service. Regenerate with <code>maw dropbox dashboard</code>.<br>Sender count is historical metadata, not online peers. This local file contains filenames; do not publish it. No credentials are embedded.</footer></html>`;
}
export function parseExtra(argv: string[]): { command: "stats" | "dashboard" | "ui" | "share"; json: boolean; open: boolean } | null {
  const [command, ...rest] = argv;
  if (!["stats","dashboard","ui","share"].includes(command)) return null;
  const allowed = command === "stats" ? ["--json"] : ["dashboard","ui"].includes(command) ? ["--open"] : [];
  if (rest.length > 1 || rest.some(arg => !allowed.includes(arg))) throw Error(`Usage: maw dropbox ${command}${allowed.length ? ` [${allowed[0]}]` : ""}`);
  return { command: command as "stats"|"dashboard"|"ui"|"share", json:rest.includes("--json"), open:rest.includes("--open") };
}
export function unsupportedNamedRoom(argv: string[], env: Record<string, string | undefined> = process.env): string | null {
  if (!["send", "status"].includes(argv[0] || "")) return null;
  const room = (env.ROOM || "default").trim() || "default";
  return room === "default" ? null : room;
}
async function openTarget(target: string): Promise<void> {
  const binary = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!binary) throw Error("Automatic open supports macOS/Linux; open the printed URL/path manually");
  const child = Bun.spawn([binary,target],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  if (await child.exited !== 0) throw Error("Could not open browser; URL/path is printed above");
}
export async function main(argv=process.argv.slice(2), log: (s:string)=>void=console.log):Promise<number> {
  let secret="";
  let redact=(text:string)=>text;
  try {
    const extra=parseExtra(argv);
    const namedRoom=unsupportedNamedRoom(argv);
    if(namedRoom)throw Error(`Installed maw dropbox v1.1.0 does not support ROOM=${JSON.stringify(namedRoom)}; use the add-on's vendored send.ts/receiver.ts CLI for named rooms`);
    const base = await import(new URL("./index.ts",import.meta.url).href);
    if (!extra) {
      const result=await base.main(argv,log);
      if (!argv.length || ["--help","-h","help"].includes(argv[0])) log("Extras: stats [--json] · dashboard [--open] · ui [--open] · share");
      return result;
    }
    const configModule=await import(new URL("./config.ts",import.meta.url).href);
    const config:Target=await configModule.resolveConfig(); secret=config.auth_key;
    redact=(text:string)=>configModule.redact(text,secret);
    const say=(text:string)=>log(redact(text));
    if(extra.command==="ui"){say(config.ingress_url);if(extra.open)await openTarget(config.ingress_url);return 0;}
    if(extra.command==="share"){
      say(`P2P Dropbox (NetBird VPN required)\nDashboard: ${config.ingress_url}\nDirect: ${config.http_url}\nReceiver: ${config.peer}\nSend: maw dropbox send --to ${JSON.stringify(config.peer)} /absolute/path/file\nHTTP <=32 MiB: maw dropbox send --http /absolute/path/file\nSupply AUTH_KEY privately; never attach it to a URL. These are service links, not anonymous per-file links.`);return 0;
    }
    const r=await fetch(config.http_url.replace(/\/$/,"")+"/api/files",{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(10000),redirect:"error"});
    if(!r.ok)throw Error(`Dropbox API HTTP ${r.status}`);
    const {stats,files}=summarize(await r.json());
    if(extra.command==="stats"){
      say(extra.json?JSON.stringify(stats,null,2):`Files: ${stats.files}\nSize: ${stats.bytes} bytes (${stats.mib} MiB)\nNamed senders: ${stats.named_senders} (not online peers)\nLatest: ${stats.latest || "none"}\nChecked: ${stats.checked_at}`);return 0;
    }
    const dir=mkdtempSync(join(tmpdir(),"maw-dropbox-dashboard-"));
    const path=join(dir,"index.html");
    // Redact before escaping into HTML so even malicious metadata cannot echo a key.
    const safeFiles=files.map(file => ({
      name:redact(file.name), size:file.size,
      sender:typeof file.sender === "string" ? redact(file.sender) : "",
      modified:typeof file.modified === "string" ? redact(file.modified) : "",
    }));
    writeFileSync(path,dashboardHtml(stats,safeFiles,config.ingress_url),{mode:0o600,flag:"wx"});
    say(path);if(extra.open)await openTarget(path);return 0;
  }catch(error){log(`error: ${redact(error instanceof Error?error.message:String(error))}`);return 1;}
}
if(import.meta.main)process.exitCode=await main();
