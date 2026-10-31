// LOCAL SIMULATION ONLY (never deployed). Runs the REAL API handlers with in-memory storage and the TEST-ONLY mock gateway, so
// you can click through the whole purchase flow without any account.
// Usage: node test/local-server.js 8787 http://127.0.0.1:8081 [--missing=NAME]
import http from "node:http";
import { route } from "../src/index.js";
import { makeEnv, makeDeps } from "./helpers.js";
import { hmacHex } from "../src/util.js";

const port = Number(process.argv[2] || 8787), site = process.argv[3] || "http://127.0.0.1:8081";
const missing = (process.argv.find((a) => a.startsWith("--missing=")) || "").slice(10);
const env = makeEnv({ SITE_URL: site, SITE_ORIGIN: site, API_URL: `http://127.0.0.1:${port}`, ...(missing ? { [missing]: "" } : {}) });
const deps = makeDeps({ now: () => Date.now() });

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = async (r) => { const h = {}; r.headers.forEach((v, k) => (h[k] = v)); res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer())); };
  if (url.pathname === "/__test/outbox") return send(Response.json(deps.outbox));
  if (url.pathname === "/__test/event" && req.method === "POST") { // act as the gateway: sign any event with the mock secret and call the webhook
    const raw = body.toString();
    return send(await route(new Request(`http://127.0.0.1:${port}/api/webhook`, { method: "POST", headers: { "x-mock-signature": await hmacHex("whsec_test", raw) }, body: raw }), env, deps));
  }
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
  const init = { method: req.method, headers }; if (!["GET", "HEAD"].includes(req.method)) init.body = body;
  send(await route(new Request(url.href, init), env, deps));
}).listen(port, "127.0.0.1", () => console.log(`local API on ${port} (mock gateway, in-memory data)`));
