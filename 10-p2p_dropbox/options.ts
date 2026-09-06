import { mkdirSync, realpathSync, writeFileSync, chmodSync, lstatSync, existsSync } from "node:fs";
import { resolve, sep, join } from "node:path";

const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a single-line string`);
  return value;
}
export function optionsEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("options must be an object");
  const o = value as Record<string, unknown>;
  const auth = text(o.auth_key ?? "", "auth_key").trim();
  if (!auth) throw new Error("auth_key is required; Nat must set it via add-on options");
  const save = text(o.save_dir ?? "/share/p2p", "save_dir");
  if (!save.startsWith("/share/") || resolve(save) !== save || save === "/share/") throw new Error("save_dir must be a normalized subdirectory of /share");
  const max = o.max_file_mb ?? 1024;
  if (!Number.isInteger(max) || Number(max) < 1 || Number(max) > 10240) throw new Error("max_file_mb must be an integer from 1 to 10240");
  const stun = o.stun_servers ?? DEFAULT_STUN;
  if (!Array.isArray(stun) || stun.length > 16 || !stun.every(v => typeof v === "string" && /^stuns?:[^\s,]+$/.test(v))) throw new Error("stun_servers must be a list of STUN URLs");
  const turn = text(o.turn_url ?? "", "turn_url").trim();
  const user = text(o.turn_user ?? "", "turn_user");
  const pass = text(o.turn_pass ?? "", "turn_pass");
  if (turn || user || pass) {
    if (!/^turns?:[^\s,]+$/.test(turn) || !user || !pass) throw new Error("set all of turn_url, turn_user and turn_pass, or leave all empty");
  }
  return {
    AUTH_KEY: auth, SAVE_DIR: save, UPLOAD_DIR: save, LOG_DIR: "/data/logs",
    HOST: "0.0.0.0", PORT: "3847", SIGNAL_URL: "ws://127.0.0.1:3847/ws",
    PEER_NAME: "p2p-dropbox", DEFAULT_PEER: "p2p-dropbox", MAX_FILE_MB: String(max),
    STUN_SERVERS: JSON.stringify(stun), TURN_URLS: turn, TURN_USER: user, TURN_CRED: pass,
  };
}

if (import.meta.main) {
  try {
    // Read Supervisor options directly: same contract as bashio, usable in local Docker too.
    const env = optionsEnvironment(await Bun.file("/data/options.json").json());
    mkdirSync("/share", { recursive: true });
    const share = realpathSync("/share");
    let segmentPath = "/share";
    for (const segment of env.SAVE_DIR.slice("/share/".length).split("/")) {
      segmentPath = join(segmentPath, segment);
      if (existsSync(segmentPath) && lstatSync(segmentPath).isSymbolicLink()) throw new Error("save_dir must not traverse symlinks");
      mkdirSync(segmentPath, { recursive: true });
    }
    if (!realpathSync(env.SAVE_DIR).startsWith(share + sep)) throw new Error("save_dir resolves outside /share");
    mkdirSync(env.LOG_DIR, { recursive: true });
    mkdirSync("/run/p2p/env", { recursive: true, mode: 0o700 });
    chmodSync("/run/p2p/env", 0o700);
    for (const [key, value] of Object.entries(env)) {
      writeFileSync(`/run/p2p/env/${key}`, value + "\n", { mode: 0o600 });
    }
    console.log("p2p_dropbox: options validated; starting authenticated server and receiver");
  } catch (error) {
    console.error(`FATAL p2p_dropbox options: ${error instanceof Error ? error.message : "invalid options"}`);
    process.exit(1);
  }
}
