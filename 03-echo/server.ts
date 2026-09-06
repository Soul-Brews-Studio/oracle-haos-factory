const port = Number(process.env.PORT ?? "8101");
// These reads are generated from the same definitions that produced config.yaml
// and run.sh. The generator asserts all three surfaces before writing anything.
const runtimeOptions = {  };

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ status: "ok", slug: "echo", options: runtimeOptions });
    }

    // Everything else echoes the request back: method, path, headers, and body.
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const body = await request.text();

    return Response.json({
      method: request.method,
      path: pathname,
      query: Object.fromEntries(new URL(request.url).searchParams),
      headers,
      body,
    });
  },
});
