import { serve } from "@hono/node-server";
import { REMOTE_PROTOCOL_VERSION } from "@remote-controle/protocol";
import { Hono } from "hono";

import { buildOpenApiDocument } from "./openapi.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createAjv, type ValidationVars } from "./validation.js";

export function createControlPlane(): Hono<{ Variables: ValidationVars }> {
  const app = new Hono<{ Variables: ValidationVars }>();
  const ajv = createAjv();

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "remote-controle-control-plane",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    }),
  );

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument()));

  app.route("/sessions", createSessionsRouter(ajv));

  return app;
}

export async function startControlPlane(): Promise<void> {
  const app = createControlPlane();
  const port = Number(process.env.PORT ?? "8080");
  const hostname = process.env.HOST ?? "0.0.0.0";

  serve({ fetch: app.fetch, port, hostname });
}

if (process.env.NODE_ENV !== "test") {
  await startControlPlane();
}
