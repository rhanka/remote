import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  DockerSessionProvisioner,
  InMemoryProvisioner,
  K8sSessionProvisioner,
  KubernetesObjectApiClient,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import {
  REMOTE_PROTOCOL_VERSION,
  sessionAnnounceSchema,
  type SessionAnnounce,
} from "@sentropic/remote-protocol";
import type { ValidateFunction } from "ajv";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { AgentRegistry } from "./agents/registry.js";
import {
  type Authenticator,
  authenticatorFromEnv,
} from "./auth/authenticator.js";
import { authMiddleware } from "./auth/middleware.js";
import {
  authEnabled,
  sessionTokenSecret,
  withSessionTokens,
} from "./auth/session-token.js";
import { buildOpenApiDocument } from "./openapi.js";
import {
  buildAgentSocketEvents,
  type AgentSocketDeps,
} from "./routes/agent-ws.js";
import { createSessionsRouter } from "./routes/sessions.js";
import type { WSEvents } from "hono/ws";
import { createWorkspacesRouter } from "./routes/workspaces.js";
import { SessionEventBus } from "./sessions/events.js";
import { SessionStore } from "./sessions/store.js";
import {
  type TenantProvisioner,
  tenantProvisionerFromEnv,
} from "./tenancy/tenant-provisioner.js";
import { createAjv, type ValidationVars } from "./validation.js";

export type ControlPlaneOptions = {
  provisioner?: SessionProvisioner;
  store?: SessionStore;
  bus?: SessionEventBus;
  registry?: AgentRegistry;
  authenticator?: Authenticator;
  tenantProvisioner?: TenantProvisioner;
};

type InjectWebSocket = ReturnType<
  typeof createNodeWebSocket
>["injectWebSocket"];

type StorageAccessMode = "ReadWriteOnce" | "ReadWriteMany";

export type ControlPlaneApp = Hono<{ Variables: ValidationVars }> & {
  injectWebSocket: InjectWebSocket;
  /** Test seam: build the wired agent-socket events (sharing the live store +
   * reconcile hook) so a `session.announce` can be driven without a real WS
   * upgrade. `userId` defaults to off-mode "default". */
  buildAgentSocketEvents(sessionId: string, userId?: string): WSEvents;
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
  let authenticator = options.authenticator ?? authenticatorFromEnv();
  // Under bearer auth, also accept per-session service tokens (minted at
  // provision time) so the session-agent's own callbacks authenticate back to
  // their owner. In off-mode this wrap is skipped — OffAuthenticator unchanged.
  const sessionSecret = sessionTokenSecret();
  if (authEnabled() && sessionSecret) {
    authenticator = withSessionTokens(authenticator, sessionSecret);
  } else if (authEnabled()) {
    // Fail loud: bearer auth is on but no session-token secret is configured
    // (e.g. JWKS-only user auth). Session-agent callbacks (workspace
    // sync/export, cli-session) will be unauthenticated and rejected 401.
    console.warn(
      "[control-plane] WARNING: REMOTE_AUTH is enabled but no session-token secret is set — session-agent callbacks (workspace sync/export, cli-session) will be UNAUTHENTICATED and rejected with 401; set REMOTE_SESSION_TOKEN_SECRET (a dedicated HS256 secret, independent of the user-auth mode) to enable them.",
    );
  }
  const tenantProvisioner =
    options.tenantProvisioner ?? tenantProvisionerFromEnv();
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

  // Build the sessions router up front so the agent-ws route can share its
  // `reconcileFromAnnounce` hook (bound over the SAME store + sessionTenant).
  const { router: sessionsRouter, reconcileFromAnnounce } =
    createSessionsRouter({
      ajv,
      store,
      bus,
      provisioner,
      registry,
      tenantProvisioner,
    });

  // Announce-body validator (durability: agent re-announce repopulates the
  // store). `sessionAnnounceSchema` is already registered on `ajv` via
  // remoteOpenApiComponents, so reuse the compiled instance.
  const announceValidator: ValidateFunction =
    (ajv.getSchema(sessionAnnounceSchema.$id) as ValidateFunction | undefined) ??
    ajv.compile(sessionAnnounceSchema);
  const validateAnnounce = (body: unknown): body is SessionAnnounce =>
    announceValidator(body) === true;

  app.get(
    "/sessions/:id/agent",
    nodeWs.upgradeWebSocket(async (c) => {
      const id = c.req.param("id") ?? "";
      // Derive the announce owner from the WS upgrade's auth context. Off-mode
      // → "default". TODO(bearer-ws-auth): the session-agent does not yet send
      // an Authorization header on the WS, so under bearer auth this falls back
      // to "default"; once the agent forwards its session token, the
      // authenticator here will resolve the real owner with no other change.
      let userId = "default";
      try {
        const auth = await authenticator.authenticate(c.req.raw);
        userId = auth.userId;
      } catch {
        userId = "default";
      }
      return buildAgentSocketEvents(id, {
        store,
        bus,
        registry,
        reconcileFromAnnounce,
        validateAnnounce,
        userId,
      });
    }),
  );

  // Authenticate every session/workspace request before it reaches the
  // routers. The agent WebSocket upgrade (handled above) and the public
  // health/OpenAPI endpoints are intentionally left unauthenticated: the
  // session-agent connects with a session id, not a user identity.
  const requireAuth = authMiddleware(authenticator);
  app.use("/sessions", requireAuth);
  app.use("/sessions/:id/*", (c, next) => {
    if (c.req.path.endsWith("/agent")) return next();
    return requireAuth(c, next);
  });
  app.use("/sessions/:id", requireAuth);
  app.use("/workspaces", requireAuth);
  app.use("/workspaces/*", requireAuth);

  app.route("/sessions", sessionsRouter);

  app.route(
    "/workspaces",
    createWorkspacesRouter({ ajv, provisioner, tenantProvisioner }),
  );

  app.injectWebSocket = nodeWs.injectWebSocket;
  app.buildAgentSocketEvents = (sessionId: string, userId = "default") => {
    const socketDeps: AgentSocketDeps = {
      store,
      bus,
      registry,
      reconcileFromAnnounce,
      validateAnnounce,
      userId,
    };
    return buildAgentSocketEvents(sessionId, socketDeps);
  };
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
    storageAccessMode?: StorageAccessMode;
    defaultWorkspaceSize?: string;
    nodeSelector?: Record<string, string>;
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
  if (process.env.SESSION_STORAGE_ACCESS_MODE)
    overrides.storageAccessMode = parseStorageAccessMode(
      process.env.SESSION_STORAGE_ACCESS_MODE,
    );
  if (process.env.SESSION_WORKSPACE_SIZE)
    overrides.defaultWorkspaceSize = process.env.SESSION_WORKSPACE_SIZE;
  if (process.env.SESSION_NODE_SELECTOR)
    overrides.nodeSelector = parseNodeSelector(
      process.env.SESSION_NODE_SELECTOR,
    );
  if (process.env.CONTROL_PLANE_ENDPOINT)
    overrides.controlPlaneEndpoint = process.env.CONTROL_PLANE_ENDPOINT;
  return new K8sSessionProvisioner(
    KubernetesObjectApiClient.fromDefault(),
    overrides,
  );
}

function parseStorageAccessMode(raw: string): StorageAccessMode {
  if (raw === "ReadWriteOnce" || raw === "ReadWriteMany") return raw;
  throw new Error(
    `Invalid SESSION_STORAGE_ACCESS_MODE "${raw}". Expected ReadWriteOnce or ReadWriteMany.`,
  );
}

function parseNodeSelector(raw: string): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error(
        `Invalid SESSION_NODE_SELECTOR entry "${trimmed}". Expected key=value pairs separated by commas.`,
      );
    }
    selector[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return selector;
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
