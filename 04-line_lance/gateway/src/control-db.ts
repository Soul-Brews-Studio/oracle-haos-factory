import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface BotInput {
  id: string;
  name: string;
  channel_secret?: string | null;
  channel_access_token?: string | null;
  bot_user_id?: string | null;
  enabled?: boolean;
}

export interface BotPatch {
  name?: string;
  channel_secret?: string | null;
  channel_access_token?: string | null;
  bot_user_id?: string | null;
  enabled?: boolean;
}

interface StoredBot {
  id: string;
  name: string;
  channel_secret: string | null;
  channel_access_token: string | null;
  bot_user_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MaskedBot {
  id: string;
  name: string;
  has_secret: boolean;
  has_token: boolean;
  bot_user_id: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const ENVELOPE_PREFIX = "v1:aes-256-gcm:";

export class ControlDb {
  readonly database: DatabaseSync;
  readonly #key: Buffer;

  constructor(databasePath: string, keyPath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#key = loadOrCreateKey(keyPath);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel_secret TEXT,
        channel_access_token TEXT,
        bot_user_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    chmodSync(databasePath, 0o600);
  }

  close(): void {
    this.database.close();
  }

  list(): MaskedBot[] {
    const rows = this.database.prepare(
      "SELECT * FROM bots ORDER BY name COLLATE NOCASE ASC, id ASC"
    ).all() as unknown as StoredBot[];
    return rows.map(maskBot);
  }

  get(id: string): MaskedBot | null {
    const row = this.#getStored(id);
    return row ? maskBot(row) : null;
  }

  create(input: BotInput): { created: boolean; bot: MaskedBot } {
    const existing = this.#getStored(input.id);
    const now = new Date().toISOString();
    const secret = own(input, "channel_secret")
      ? this.#encrypt(input.channel_secret ?? null)
      : existing?.channel_secret ?? null;
    const token = own(input, "channel_access_token")
      ? this.#encrypt(input.channel_access_token ?? null)
      : existing?.channel_access_token ?? null;
    const userId = own(input, "bot_user_id") ? input.bot_user_id ?? null : existing?.bot_user_id ?? null;
    const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
    const createdAt = existing?.created_at ?? now;

    this.database.prepare(`
      INSERT INTO bots (id, name, channel_secret, channel_access_token, bot_user_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, channel_secret=excluded.channel_secret,
        channel_access_token=excluded.channel_access_token, bot_user_id=excluded.bot_user_id,
        enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run(input.id, input.name, secret, token, userId, enabled ? 1 : 0, createdAt, now);

    return { created: !existing, bot: this.get(input.id)! };
  }

  update(id: string, patch: BotPatch): MaskedBot | null {
    const existing = this.#getStored(id);
    if (!existing) return null;
    const next: BotInput = {
      id,
      name: patch.name ?? existing.name,
      enabled: patch.enabled ?? existing.enabled === 1,
      bot_user_id: own(patch, "bot_user_id") ? patch.bot_user_id ?? null : existing.bot_user_id
    };
    if (own(patch, "channel_secret")) next.channel_secret = patch.channel_secret ?? null;
    if (own(patch, "channel_access_token")) next.channel_access_token = patch.channel_access_token ?? null;
    return this.create(next).bot;
  }

  delete(id: string): boolean {
    return Number(this.database.prepare("DELETE FROM bots WHERE id = ?").run(id).changes) > 0;
  }

  /** Test/support hook: decrypts credentials without ever exposing them over HTTP. */
  credential(id: string, field: "channel_secret" | "channel_access_token"): string | null {
    const row = this.#getStored(id);
    return row ? this.#decrypt(row[field]) : null;
  }

  #getStored(id: string): StoredBot | null {
    return (this.database.prepare("SELECT * FROM bots WHERE id = ? LIMIT 1").get(id) as unknown as StoredBot | undefined) ?? null;
  }

  #encrypt(value: string | null): string | null {
    if (value === null) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
  }

  #decrypt(envelope: string | null): string | null {
    if (envelope === null) return null;
    if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new Error("unsupported credential envelope");
    const parts = envelope.slice(ENVELOPE_PREFIX.length).split(":");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("invalid credential envelope");
    const [ivText, tagText, ciphertextText] = parts as [string, string, string];
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}

function maskBot(row: StoredBot): MaskedBot {
  return {
    id: row.id,
    name: row.name,
    has_secret: Boolean(row.channel_secret),
    has_token: Boolean(row.channel_access_token),
    bot_user_id: row.bot_user_id,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function loadOrCreateKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, randomBytes(32));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error(`CONTROL_KEY must contain exactly 32 bytes: ${path}`);
  return key;
}
