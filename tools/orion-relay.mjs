import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 43210;

function setCors(req, res) {
  const origin = req.headers.origin || "[https://discord.com](https://discord.com)";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Orion-Relay");
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && req.url === "/proxy") {
    if (req.headers["x-orion-relay"] !== "1") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Missing X-Orion-Relay header");
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    try {
      const { url, headers = {}, body } = JSON.parse(raw);
      const target = new URL(url);
      if (target.protocol !== "https:" || !target.hostname.endsWith(".discordsays.com")) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Blocked target host");
      }

      const questId = headers["X-Discord-Quest-ID"] || headers["x-discord-quest-id"];
      let forwardBody = body;
      if (questId && typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object" && !parsed.quest_id) {
            parsed.quest_id = questId;
            forwardBody = JSON.stringify(parsed);
          }
        } catch {}
      }

      const upstream = await fetch(target.toString(), {
        method: "POST",
        headers,
        body: forwardBody,
        redirect: "error",
      });
      const text = await upstream.text();

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: upstream.ok,
        status: upstream.status,
        body: text,
      }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end(String(err?.message || err));
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Orion Relay listening on http://${HOST}:${PORT}`);
});
