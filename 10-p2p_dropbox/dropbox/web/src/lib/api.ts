import { resolveAppUrl } from "./routing";

const STORAGE_PREFIX = `p2p-dropbox:${window.location.pathname.replace(/[^a-z0-9]/gi, "_")}`;
const KEY_STORAGE = `${STORAGE_PREFIX}:auth-key`;
const PEER_STORAGE = `${STORAGE_PREFIX}:peer-name`;
const AUTH_FAILED_EVENT = "p2p-dropbox:auth-failed";

export interface IngressSession {
  token: string;
  expiresAt: number;
  userId: string;
  userName: string;
}

export interface IngressAuthResult {
  ok: boolean;
  ingress: boolean;
  token?: string;
  expires_at?: number;
  user_id: string;
  user_name: string;
  error?: string;
  allowlistOption?: string;
}

let ingressSession: IngressSession | null = null;

function endpoint(path: string): string {
  return resolveAppUrl(document.baseURI, path);
}

export interface AppConfig {
  iceServers: RTCIceServer[];
  max_file_mb: number;
  http_max_file_mb?: number;
  receiver_peer_name?: string;
  signal_token?: string;
}

export function getApiKey(): string {
  return ingressSession?.token || getManualApiKey();
}

export function getManualApiKey(): string {
  return sessionStorage.getItem(KEY_STORAGE) || "";
}

export function setApiKey(key: string) {
  if (key) sessionStorage.setItem(KEY_STORAGE, key);
  else sessionStorage.removeItem(KEY_STORAGE);
}

export function getIngressSession(): IngressSession | null {
  return ingressSession;
}

export function setIngressSession(result: IngressAuthResult): IngressSession {
  if (!result.ok || !result.token || !Number.isFinite(result.expires_at)) {
    throw new Error("Server returned an invalid ingress session");
  }
  ingressSession = {
    token: result.token,
    expiresAt: result.expires_at!,
    userId: result.user_id || "",
    userName: result.user_name || "",
  };
  return ingressSession;
}

export function clearIngressSession(): void {
  ingressSession = null;
}

function failClosedOnUnauthorized(status: number, rejectedCredential: string): void {
  if (status !== 401 || !ingressSession || ingressSession.token !== rejectedCredential) return;
  ingressSession = null;
  window.dispatchEvent(new Event(AUTH_FAILED_EVENT));
}

export function onAuthFailed(listener: () => void): () => void {
  window.addEventListener(AUTH_FAILED_EVENT, listener);
  return () => window.removeEventListener(AUTH_FAILED_EVENT, listener);
}

export async function bootstrapIngressAuth(signal?: AbortSignal): Promise<IngressAuthResult> {
  const res = await fetch(endpoint("auth/ingress"), {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const result = await res.json() as IngressAuthResult;
  if (typeof result.ok !== "boolean" || typeof result.ingress !== "boolean") {
    throw new Error("Server returned an invalid ingress authentication response");
  }
  return result;
}

export function getPeerName(): string {
  return sessionStorage.getItem(PEER_STORAGE) || "";
}

export function setPeerName(name: string) {
  sessionStorage.setItem(PEER_STORAGE, name);
}

async function authenticatedFetch(path: string, init: RequestInit = {}, key = getApiKey()) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const res = await fetch(endpoint(path), { ...init, headers });
  failClosedOnUnauthorized(res.status, key);
  return res;
}

export async function validateApiKey(key: string): Promise<AppConfig> {
  const res = await authenticatedFetch("api/config", {}, key);
  if (!res.ok) throw new Error(res.status === 401 ? "Invalid auth key" : `Server returned HTTP ${res.status}`);
  const config = await res.json() as AppConfig;
  if (!Array.isArray(config.iceServers) || !Number.isFinite(config.max_file_mb)) {
    throw new Error("Server returned an invalid configuration");
  }
  return config;
}

export interface FileEntry { name: string; date: string; size: number; modified: string; sender: string }
export interface FilesResponse { files: FileEntry[]; total: number; senders: string[] }

export async function listFiles(): Promise<FilesResponse> {
  const res = await authenticatedFetch("api/files");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function uploadFile(file: File, onProgress?: (pct: number) => void): Promise<{ name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const credential = getApiKey();
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
    };
    xhr.onload = () => {
      failClosedOnUnauthorized(xhr.status, credential);
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`HTTP upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("HTTP upload network error"));
    xhr.open("POST", endpoint("api/upload"));
    xhr.setRequestHeader("Authorization", `Bearer ${credential}`);
    xhr.send(form);
  });
}

export async function downloadFile(name: string): Promise<void> {
  const res = await authenticatedFetch(`api/files/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type PreviewData =
  | { type: "image"; url: string; size: number }
  | { type: "pdf"; url: string; size: number }
  | { type: "text"; content: string; lines: number; totalLines: number; truncated: boolean }
  | { type: "binary"; size: number };

export async function fetchPreview(name: string): Promise<PreviewData> {
  const res = await authenticatedFetch(`api/preview/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as PreviewData;
  if (data.type === "image" || data.type === "pdf") {
    const file = await authenticatedFetch(`api/files/${encodeURIComponent(name)}`);
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
    data.url = URL.createObjectURL(await file.blob());
  }
  return data;
}

export function signalingWsUrl(token: string): string {
  const url = new URL("ws", document.baseURI);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}
