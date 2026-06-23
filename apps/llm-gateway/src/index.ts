import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { acquireSession, sessionCount } from "./sticky.js";
import { handleMessages } from "./proxy-anthropic.js";

const app = new Hono();

// Health — no internal state exposed
app.get("/health", (c) => c.json({ ok: true }));
app.get("/healthz", (c) => c.json({ ok: true }));

// Session creation — called by control-plane before pod start.
// Network policy enforces that pods cannot reach this endpoint.
app.post("/v1/session", async (c) => {
  let body: { sessionId?: unknown; provider?: unknown };
  try {
    body = await c.req.json<{ sessionId?: unknown; provider?: unknown }>();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    return c.json({ error: "sessionId (string) required" }, 400);
  }
  const result = await acquireSession(body.sessionId);
  return c.json(result, 201);
});

// Anthropic Messages proxy — pods call this with Bearer gw-<hex>
app.post("/v1/messages", handleMessages);

const port = parseInt(process.env.PORT ?? "3001", 10);
serve({ fetch: app.fetch, port }, () => {
  process.stdout.write(
    `[llm-gateway] listening on :${port} — ${sessionCount()} sessions in memory\n`,
  );
});
