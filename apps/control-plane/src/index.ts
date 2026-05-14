import { serve } from "@hono/node-server";
import {
  InMemoryProvisioner,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import { REMOTE_PROTOCOL_VERSION } from "@sentropic/remote-protocol";
import { Hono } from "hono";

import { buildOpenApiDocument } from "./openapi.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { SessionEventBus } from "./sessions/events.js";
import { SessionStore } from "./sessions/store.js";
import { createAjv, type ValidationVars } from "./validation.js";

export type ControlPlaneOptions = {
  provisioner?: SessionProvisioner;
  store?: SessionStore;
  bus?: SessionEventBus;
};

export function createControlPlane(
  options: ControlPlaneOptions = {},
): Hono<{ Variables: ValidationVars }> {
  const app = new Hono<{ Variables: ValidationVars }>();
  const ajv = createAjv();
  const store = options.store ?? new SessionStore();
  const bus = options.bus ?? new SessionEventBus();
  const provisioner = options.provisioner ?? new InMemoryProvisioner();

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "sentropic-remote-control-plane",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    }),
  );

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument()));

  app.route("/sessions", createSessionsRouter(ajv, store, bus, provisioner));

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
