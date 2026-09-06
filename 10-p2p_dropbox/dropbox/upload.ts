#!/usr/bin/env bun
/**
 * CLI uploader for PhD Dropbox — works standalone or as maw verb
 *
 * Usage:
 *   bun run upload.ts <file> [file2] [file3] ...
 *   bun run upload.ts *.nc
 *   bun run upload.ts --list
 *   bun run upload.ts --url https://custom-tunnel.trycloudflare.com <file>
 */

const DEFAULT_URL = "http://localhost:3847";

const args = process.argv.slice(2);
let baseUrl = DEFAULT_URL;
// #80: server requires AUTH_KEY on /api/* — same key as the web login / signaling
let authKey = (process.env.AUTH_KEY || "").trim();
const files: string[] = [];
let listMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url" && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, "");
  } else if (args[i] === "--key" && args[i + 1]) {
    authKey = args[++i];
  } else if (args[i] === "--list" || args[i] === "-l") {
    listMode = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
🛰️ PhD Dropbox CLI

Usage:
  bun run upload.ts <file> [file2] ...   Upload files
  bun run upload.ts --list               List uploaded files
  bun run upload.ts --url <URL> <file>   Use custom server URL
  bun run upload.ts --key <AUTH_KEY>     Override AUTH_KEY (default: env)

Auth:
  Server requires AUTH_KEY (#80). Set AUTH_KEY in env/.env or pass --key.

Examples:
  bun run upload.ts data.nc paper.pdf
  bun run upload.ts --list
  bun run upload.ts --url https://xyz.trycloudflare.com data.nc
`);
    process.exit(0);
  } else {
    files.push(args[i]);
  }
}

if (!authKey) {
  console.error("❌ AUTH_KEY not set — server rejects unauthenticated /api/* (#80). Set AUTH_KEY in env or pass --key.");
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${authKey}` };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function listFiles() {
  try {
    const res = await fetch(`${baseUrl}/api/files`, { headers: authHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { files, total } = (await res.json()) as { files: { name: string; size: number; modified: string }[]; total: number };
    console.log(`📋 ${total} files on dropbox (${baseUrl}):\n`);
    for (const f of files) {
      const date = new Date(f.modified).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
      console.log(`  ${f.name}  ${formatSize(f.size).padStart(10)}  ${date}`);
    }
  } catch (err) {
    console.error(`❌ Cannot connect to ${baseUrl}: ${err}`);
    process.exit(1);
  }
}

async function uploadFile(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`❌ File not found: ${path}`);
    return false;
  }

  const size = file.size;
  console.log(`📤 Uploading: ${path} (${formatSize(size)})`);

  const form = new FormData();
  form.append("file", file);

  try {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/api/upload`, { method: "POST", body: form, headers: authHeaders });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ Upload failed: ${err}`);
      return false;
    }

    const data = (await res.json()) as { ok: boolean; name: string; size: number };
    const speed = (size / 1024 / 1024 / parseFloat(elapsed)).toFixed(1);
    console.log(`✅ ${data.name} (${formatSize(data.size)}) in ${elapsed}s (${speed} MB/s)`);
    return true;
  } catch (err) {
    console.error(`❌ Upload error: ${err}`);
    return false;
  }
}

async function main() {
  if (listMode) {
    await listFiles();
    return;
  }

  if (files.length === 0) {
    console.error("Usage: bun run upload.ts <file> [file2] ...\n       bun run upload.ts --list");
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const f of files) {
    if (await uploadFile(f)) ok++;
    else fail++;
  }

  console.log(`\n📊 Done: ${ok} uploaded, ${fail} failed`);
  if (fail > 0) process.exit(2);
}

main();
