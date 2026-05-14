import { serve } from "@hono/node-server";
import { REMOTE_PROTOCOL_VERSION } from "@remote-controle/protocol";
import { Hono } from "hono";

export function createControlPlane(): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "remote-controle-control-plane",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    }),
  );

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
