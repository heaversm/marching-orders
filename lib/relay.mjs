// A small relay on this computer for Claude calls. Some Anthropic organizations
// (custom data-retention settings) refuse any call made from a browser. The
// extension sends its calls here instead, and this forwards them to
// api.anthropic.com as an ordinary program would. It stores nothing: the key
// arrives with each request and is passed straight through.
// Listens on 127.0.0.1 only, and only for Firefox extension pages.
// Usage: node lib/relay.mjs [port]   (default 8091)
import { createServer } from "node:http";

export const RELAY_PORT = 8091;
const PASS = ["x-api-key", "anthropic-version", "anthropic-beta", "content-type", "accept"];

export function startRelay(port = RELAY_PORT) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (origin && !origin.startsWith("moz-extension://")) { res.writeHead(403, cors); return res.end("Only Firefox extensions may use this relay."); }
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(404, cors); return res.end("Only /v1/messages is relayed."); }
    const body = await new Promise((resolve) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts))); });
    const headers = Object.fromEntries(PASS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    // The SDK may send the key as "Authorization: Bearer <key>". Pass an API key on as x-api-key.
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!headers["x-api-key"] && bearer) {
      if (bearer.startsWith("sk-ant-api")) headers["x-api-key"] = bearer;
      else headers.authorization = req.headers.authorization;
    }
    try {
      const up = await fetch(`https://api.anthropic.com${req.url}`, { method: "POST", headers, body });
      const out = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { ...cors, "content-type": up.headers.get("content-type") ?? "application/json", ...(up.headers.get("request-id") ? { "request-id": up.headers.get("request-id") } : {}) });
      res.end(out);
    } catch (e) {
      res.writeHead(502, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "relay_error", message: `The relay couldn't reach Anthropic: ${e.message}` } }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? RELAY_PORT);
  await startRelay(port);
  console.log(`Claude relay for Marching Orders on http://127.0.0.1:${port}. Leave this running; Ctrl-C to stop.`);
}
