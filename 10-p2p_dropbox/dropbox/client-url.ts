import { sanitizeRoom } from "./signaling";

/** ROOM overrides the URL query; both omitted selects the default room. */
export function signalingClientUrl(signalUrl: string, key: string, room?: string): string {
  const url = new URL(signalUrl);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("SIGNAL_URL must be a ws/wss URL without userinfo");
  }
  const selected = sanitizeRoom(room ?? url.searchParams.get("room"));
  if (!selected) throw new Error("ROOM must contain 1-64 letters, digits, dots, underscores or hyphens");
  url.searchParams.set("room", selected);
  url.searchParams.delete("token");
  url.searchParams.set("key", key);
  return url.toString();
}
