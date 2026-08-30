const port = Number(process.env.PORT ?? "8099");
// This is the third option edit: Supervisor -> run.sh -> GREETING. Reading the
// environment here keeps runtime configuration out of immutable image layers.
const greeting = process.env.GREETING ?? "hello";

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(greeting, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ status: "ok", greeting });
    }

    return new Response("Not found", { status: 404 });
  },
});
