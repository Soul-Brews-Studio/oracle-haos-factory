import { createGateway } from "./app.js";

const port = Number(process.env.PORT ?? "4134");
const host = process.env.HOST ?? "0.0.0.0";
const app = createGateway();

app.listen({ hostname: host, port });
console.log(`LINE Lance Elysia gateway listening on http://${host}:${port}`);
