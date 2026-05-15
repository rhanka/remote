import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  InMemoryProvisioner,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import { REMOTE_PROTOCOL_VERSION } from "@sentropic/remote-protocol";
import { Hono } from "hono";

import { AgentRegistry } from "./agents/registry.js";
import { buildOpenApiDocument } from "./openapi.js";
import { buildAgentSocketEvents } from "./routes/agent-ws.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { SessionEventBus } from "./sessions/events.js";
import { SessionStore } from "./sessions/store.js";
import { createAjv, type ValidationVars } from "./validation.js";

export type ControlPlaneOptions = {
  provisioner?: SessionProvisioner;
  store?: SessionStore;
  bus?: SessionEventBus;
  registry?: AgentRegistry;
};

type InjectWebSocket = ReturnType<
  typeof createNodeWebSocket
>["injectWebSocket"];

export type ControlPlaneApp = Hono<{ Variables: ValidationVars }> & {
  injectWebSocket: InjectWebSocket;
};

export function createControlPlane(
  options: ControlPlaneOptions = {},
): ControlPlaneApp {
  const app = new Hono<{ Variables: ValidationVars }>() as ControlPlaneApp;
  const ajv = createAjv();
  const store = options.store ?? new SessionStore();
  const bus = options.bus ?? new SessionEventBus();
  const provisioner = options.provisioner ?? new InMemoryProvisioner();
  const registry = options.registry ?? new AgentRegistry();
  const nodeWs = createNodeWebSocket({ app });

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "sentropic-remote-control-plane",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    }),
  );

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument()));

  app.get(
    "/sessions/:id/agent",
    nodeWs.upgradeWebSocket((c) => {
      const id = c.req.param("id") ?? "";
      return buildAgentSocketEvents(id, { store, bus, registry });
    }),
  );

  app.route(
    "/sessions",
    createSessionsRouter({ ajv, store, bus, provisioner, registry }),
  );

  app.injectWebSocket = nodeWs.injectWebSocket;
  return app;
}

export async function startControlPlane(): Promise<void> {
  const app = createControlPlane();
  const port = Number(process.env.PORT ?? "8080");
  const hostname = process.env.HOST ?? "0.0.0.0";

  const server = serve({ fetch: app.fetch, port, hostname });
  app.injectWebSocket(server);
}

if (process.env.NODE_ENV !== "test") {
  await startControlPlane();
}
