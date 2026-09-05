interface Env {
  ASSETS: Fetcher;
  LANCE_API_URL?: string;
  LANCE_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.LANCE_API_URL || env.LANCE_API_URL.includes("replace-with")) {
      return Response.json({ error: "LANCE_API_URL is not configured for this Worker" }, { status: 503 });
    }
    const target = new URL(incoming.pathname + incoming.search, env.LANCE_API_URL);
    const headers = new Headers(request.headers);
    if (env.LANCE_API_TOKEN) headers.set("Authorization", `Bearer ${env.LANCE_API_TOKEN}`);
    headers.delete("host");
    return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
  },
} satisfies ExportedHandler<Env>;

