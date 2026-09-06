import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import type { WriteStream } from "fs";
import { basename, join } from "path";

export interface CompletedTransfer {
  id: string;
  originalName: string;
  savedAs: string;
  size: number;
  senderPeerId: string;
}

export interface TransferRegistryOptions {
  saveDir: string;
  maxFileBytes: number;
  onComplete: (transfer: CompletedTransfer) => void | Promise<void>;
  log?: (message: string) => void;
}

interface ActiveTransfer {
  id: string;
  originalName: string;
  size: number;
  received: number;
  finalPath: string;
  partPath: string;
  stream: WriteStream;
  failed: boolean;
}

type SendControl = (message: string) => void;
const BLOCKED_EXTENSIONS = [".env", ".key", ".pem", ".p12", ".pfx", ".secret", ".credentials"];

function safeBaseName(name: string): string {
  const cleaned = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

function isSensitiveName(name: string): boolean {
  const lower = basename(name).toLowerCase();
  return BLOCKED_EXTENSIONS.some((extension) => lower.endsWith(extension)) ||
    lower.includes("password") || lower.includes("secret") || lower.includes("credential") ||
    lower.includes(".netrc") || lower.includes("id_rsa") || lower.includes("id_ed25519");
}

function uniquePath(dir: string, name: string, id: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}_${id}_${safeBaseName(name)}`;
  let candidate = join(dir, base);
  let suffix = 1;
  while (existsSync(candidate) || existsSync(`${candidate}.part`)) {
    candidate = join(dir, `${base}.${suffix++}`);
  }
  return candidate;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function removePartWhenClosed(transfer: ActiveTransfer): void {
  const remove = () => { try { unlinkSync(transfer.partPath); } catch {} };
  transfer.stream.once("close", remove);
  transfer.stream.destroy();
  remove();
}

export class TransferRegistry {
  private readonly claimedIds = new Set<string>();

  constructor(readonly options: TransferRegistryOptions) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0) {
      throw new Error("maxFileBytes must be a non-negative safe integer");
    }
    mkdirSync(options.saveDir, { recursive: true });
  }

  createSession(peerId: string, send: SendControl): ReceiverTransferSession {
    return new ReceiverTransferSession(this, peerId, send);
  }

  claim(id: string): boolean {
    if (this.claimedIds.has(id)) return false;
    this.claimedIds.add(id);
    return true;
  }

  release(id: string): void {
    this.claimedIds.delete(id);
  }
}

export class ReceiverTransferSession {
  private active: ActiveTransfer | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: TransferRegistry,
    private readonly peerId: string,
    private readonly send: SendControl,
  ) {}

  handleMessage(data: Buffer | Uint8Array | string): void {
    // DataChannel message type is the protocol boundary. Binary bytes are always
    // payload, even when they happen to contain valid JSON text.
    if (typeof data !== "string") {
      this.handleBinary(Buffer.from(data));
      return;
    }

    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      this.registry.options.log?.(`Ignoring malformed control message from ${this.peerId}`);
      return;
    }

    if (message?.type === "file-start") this.start(message);
    else if (message?.type === "file-end") this.finish(message);
  }

  close(reason = "sender disconnected"): void {
    if (this.active) this.abort(this.active, reason, true);
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  private start(message: any): void {
    const id = message?.id;
    const name = message?.name;
    const size = message?.size;

    if (this.active) {
      // Binary chunks have no transfer id. Any overlapping start (even malformed)
      // destroys framing, so terminate the old transfer rather than risk corruption.
      this.abort(this.active, "overlapping file-start", true);
      this.reject(validId(id) ? id : "", 0, "overlapping file-start");
      return;
    }

    if (!validId(id) || typeof name !== "string" || name.length === 0 || name.length > 1024 ||
        !Number.isSafeInteger(size) || size < 0 || size > this.registry.options.maxFileBytes) {
      this.reject(validId(id) ? id : "", 0, "invalid or oversized file-start");
      return;
    }
    if (isSensitiveName(name)) {
      this.reject(id, 0, "sensitive file type blocked for safety");
      return;
    }

    if (!this.registry.claim(id)) {
      this.reject(id, 0, "duplicate active transfer id");
      return;
    }

    const finalPath = uniquePath(this.registry.options.saveDir, name, id);
    const partPath = `${finalPath}.${id}.part`;
    const stream = createWriteStream(partPath, { flags: "wx" });
    const transfer: ActiveTransfer = {
      id,
      originalName: name,
      size,
      received: 0,
      finalPath,
      partPath,
      stream,
      failed: false,
    };
    this.active = transfer;
    stream.once("error", (error) => {
      if (this.active === transfer && !transfer.failed) {
        this.abort(transfer, `disk write failed: ${error.message}`, true);
      }
    });
  }

  private handleBinary(chunk: Buffer): void {
    const transfer = this.active;
    if (!transfer || transfer.failed) return;
    if (transfer.received + chunk.byteLength > transfer.size ||
        transfer.received + chunk.byteLength > this.registry.options.maxFileBytes) {
      this.abort(transfer, "received data exceeds declared or configured size", true);
      return;
    }
    transfer.received += chunk.byteLength;
    transfer.stream.write(chunk);
  }

  private finish(message: any): void {
    const transfer = this.active;
    if (!transfer || message?.id !== transfer.id) {
      if (validId(message?.id)) this.reject(message.id, 0, "unknown transfer id");
      return;
    }
    this.active = null;
    this.pending = this.pending.then(() => this.finalize(transfer));
  }

  private async finalize(transfer: ActiveTransfer): Promise<void> {
    if (transfer.failed) return;
    if (transfer.received !== transfer.size) {
      this.abortDetached(transfer, "received size does not match declaration", true);
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        transfer.stream.once("error", onError);
        transfer.stream.end(() => {
          transfer.stream.off("error", onError);
          resolve();
        });
      });
      renameSync(transfer.partPath, transfer.finalPath);
      await this.registry.options.onComplete({
        id: transfer.id,
        originalName: transfer.originalName,
        savedAs: transfer.finalPath,
        size: transfer.received,
        senderPeerId: this.peerId,
      });
      this.emit({ type: "file-received", id: transfer.id, size: transfer.received, ok: true });
    } catch (error) {
      try { unlinkSync(transfer.finalPath); } catch {}
      try { unlinkSync(transfer.partPath); } catch {}
      this.registry.options.log?.(`Transfer ${transfer.id} failed: ${error}`);
      this.reject(transfer.id, transfer.received, "flush or commit failed");
    } finally {
      transfer.failed = true;
      this.registry.release(transfer.id);
    }
  }

  private abort(transfer: ActiveTransfer, reason: string, acknowledge: boolean): void {
    if (this.active === transfer) this.active = null;
    this.abortDetached(transfer, reason, acknowledge);
  }

  private abortDetached(transfer: ActiveTransfer, reason: string, acknowledge: boolean): void {
    if (transfer.failed) return;
    transfer.failed = true;
    removePartWhenClosed(transfer);
    this.registry.release(transfer.id);
    this.registry.options.log?.(`Transfer ${transfer.id} rejected: ${reason}`);
    if (acknowledge) this.reject(transfer.id, transfer.received, reason);
  }

  private reject(id: string, size: number, reason: string): void {
    this.emit({ type: "file-received", id, size, ok: false, error: reason });
  }

  private emit(message: Record<string, unknown>): void {
    try {
      this.send(JSON.stringify(message));
    } catch (error) {
      this.registry.options.log?.(`Could not send transfer acknowledgement to ${this.peerId}: ${error}`);
    }
  }
}
