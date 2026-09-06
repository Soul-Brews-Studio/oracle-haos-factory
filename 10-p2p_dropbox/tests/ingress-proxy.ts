// Local-only HA ingress simulation: prefix stripped, X-Ingress-Path forwarded.
// Usage: UPSTREAM=http://127.0.0.1:<docker-port> bun tests/ingress-proxy.ts
import type { ServerWebSocket } from "bun";
const upstream = process.env.UPSTREAM;
if (!upstream || !/^http:\/\/127\.0\.0\.1:\d+$/.test(upstream)) throw new Error("UPSTREAM must be a loopback Docker URL");
const prefix = `/api/hassio_ingress/${process.env.PROOF_PREFIX || "local-proof"}/`;
const BunSocket = WebSocket as unknown as { new(url: URL, options: Bun.WebSocketOptions): WebSocket };
function ingressHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.set("x-ingress-path", prefix.slice(0, -1));
  headers.set("x-remote-user-id", process.env.PROOF_USER_ID || "fixture-admin");
  headers.set("x-remote-user-name", process.env.PROOF_USER_NAME || "Fixture User");
  headers.delete("x-remote-user-is-admin");
  headers.delete("host");
  return headers;
}
type Connection = { upstream: WebSocket; queue: (string | Buffer)[]; downstream?: ServerWebSocket<Connection> };
const proxy = Bun.serve<Connection>({
  hostname: "127.0.0.1", port: Number(process.env.PROXY_PORT || 0),
  async fetch(request, server) {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith(prefix)) return new Response("prefix required", { status: 404 });
    const url = new URL(incoming.pathname.slice(prefix.length) + incoming.search, upstream + "/");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      url.protocol = "ws:";
      const socket = new BunSocket(url, { headers: Object.fromEntries(ingressHeaders(request)) });
      const connection: Connection = { upstream: socket, queue: [] };
      socket.onopen = () => { for (const data of connection.queue) socket.send(typeof data === "string" ? data : new Uint8Array(data)); connection.queue = []; };
      socket.onmessage = event => connection.downstream?.send(typeof event.data === "string" ? event.data : Buffer.from(event.data));
      socket.onclose = () => connection.downstream?.close();
      socket.onerror = () => connection.downstream?.close();
      if (server.upgrade(request, { data: connection })) return;
      socket.close();
      return new Response("upgrade failed", { status: 400 });
    }
    const headers = ingressHeaders(request);
    return fetch(url, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "manual" });
  },
  websocket: {
    open(socket) { socket.data.downstream = socket; },
    message(socket, data) {
      if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(typeof data === "string" ? data : new Uint8Array(data));
      else socket.data.queue.push(data);
    },
    close(socket) { socket.data.upstream.close(); },
  },
});
console.log(`http://127.0.0.1:${proxy.port}${prefix}`);
