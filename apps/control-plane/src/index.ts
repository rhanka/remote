import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  DockerSessionProvisioner,
  InMemoryProvisioner,
  K8sSessionProvisioner,
  KubernetesObjectApiClient,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import { REMOTE_PROTOCOL_VERSION } from "@sentropic/remote-protocol";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { AgentRegistry } from "./agents/registry.js";
import { buildOpenApiDocument } from "./openapi.js";
import { buildAgentSocketEvents } from "./routes/agent-ws.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createWorkspacesRouter } from "./routes/workspaces.js";
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

  // Permissive CORS for the POC operator-UI. Tighten origin allowlist before
  // exposing the control-plane to a public Ingress.
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    }),
  );

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

  app.route("/workspaces", createWorkspacesRouter({ ajv, provisioner }));

  app.injectWebSocket = nodeWs.injectWebSocket;
  return app;
}

export function provisionerFromEnv(): SessionProvisioner {
  if (process.env.SESSION_BACKEND === "docker") {
    return new DockerSessionProvisioner({
      ...(process.env.SESSION_AGENT_IMAGE
        ? { image: process.env.SESSION_AGENT_IMAGE }
        : {}),
      ...(process.env.SESSION_DOCKER_CONTROL_PLANE_ENDPOINT
        ? {
            controlPlaneEndpoint:
              process.env.SESSION_DOCKER_CONTROL_PLANE_ENDPOINT,
          }
        : {}),
      ...(process.env.SESSION_DOCKER_NETWORK
        ? { network: process.env.SESSION_DOCKER_NETWORK }
        : {}),
    });
  }
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) return new InMemoryProvisioner();
  const overrides: {
    namespace: string;
    image?: string;
    imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
    storageClassName?: string;
    controlPlaneEndpoint?: string;
  } = { namespace };
  if (process.env.SESSION_AGENT_IMAGE)
    overrides.image = process.env.SESSION_AGENT_IMAGE;
  const rawPullPolicy = process.env.SESSION_AGENT_IMAGE_PULL_POLICY;
  if (
    rawPullPolicy === "Always" ||
    rawPullPolicy === "IfNotPresent" ||
    rawPullPolicy === "Never"
  ) {
    overrides.imagePullPolicy = rawPullPolicy;
  }
  if (process.env.SESSION_STORAGE_CLASS)
    overrides.storageClassName = process.env.SESSION_STORAGE_CLASS;
  if (process.env.CONTROL_PLANE_ENDPOINT)
    overrides.controlPlaneEndpoint = process.env.CONTROL_PLANE_ENDPOINT;
  return new K8sSessionProvisioner(
    KubernetesObjectApiClient.fromDefault(),
    overrides,
  );
}

export async function startControlPlane(): Promise<void> {
  const app = createControlPlane({ provisioner: provisionerFromEnv() });
  const port = Number(process.env.PORT ?? "8080");
  const hostname = process.env.HOST ?? "0.0.0.0";

  const server = serve({ fetch: app.fetch, port, hostname });
  app.injectWebSocket(server);
}

if (process.env.NODE_ENV !== "test") {
  await startControlPlane();
}
