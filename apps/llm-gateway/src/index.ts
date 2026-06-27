import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { acquireSession, sessionCount } from "./sticky.js";
import { handleMessages } from "./proxy-anthropic.js";
import { listAccountDescriptors, listRoutableModels } from "./accounts.js";
import { modelCatalogResponse } from "./model-catalog.js";
import { getSessionLedgerEntry, listSessionLedger } from "./session-ledger.js";

export const app = new Hono();

// Health — no internal state exposed
app.get("/health", (c) => c.json({ ok: true }));
app.get("/healthz", (c) => c.json({ ok: true }));

// Session creation — called by control-plane before pod start.
// Network policy enforces that pods cannot reach this endpoint.
app.post("/v1/session", async (c) => {
  let body: {
    sessionId?: unknown;
    provider?: unknown;
    model?: unknown;
    workspaceId?: unknown;
    profile?: unknown;
    clientSessionId?: unknown;
  };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    return c.json({ error: "sessionId (string) required" }, 400);
  }
  try {
    const result = await acquireSession(body.sessionId, {
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
      ...(typeof body.profile === "string" ? { profile: body.profile } : {}),
      ...(typeof body.clientSessionId === "string" ? { clientSessionId: body.clientSessionId } : {}),
    });
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/v1/accounts", (c) => c.json({ data: listAccountDescriptors() }));
app.get("/v1/models", (c) => c.json(modelCatalogResponse(listRoutableModels())));
app.get("/v1/sessions", (c) => c.json({ data: listSessionLedger() }));
app.get("/v1/sessions/:id", (c) => {
  const entry = getSessionLedgerEntry(c.req.param("id"));
  if (!entry) return c.json({ error: "session not found" }, 404);
  return c.json(entry);
});

// Anthropic Messages proxy — pods call this with Bearer gw-<hex>
app.post("/v1/messages", handleMessages);

export function startServer(): void {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  serve({ fetch: app.fetch, port }, () => {
    process.stdout.write(
      `[llm-gateway] listening on :${port} — ${sessionCount()} sessions in memory\n`,
    );
  });
}

if (process.env.NODE_ENV !== "test") startServer();
