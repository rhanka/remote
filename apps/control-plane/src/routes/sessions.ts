import {
  InMemoryProvisioner,
  type ProvisionerEmit,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
  createSessionRequestSchema,
  refreshSessionCredentialsRequestSchema,
  sendInstructionRequestSchema,
  stopSessionRequestSchema,
  terminalInputSchema,
  terminalResizeSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type RefreshSessionCredentialsRequest,
  type RefreshSessionCredentialsResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
  type RemoteEventEnvelope,
  type SendInstructionRequest,
  type SendInstructionResponse,
  type SessionDescriptor,
  type StopSessionRequest,
  type StopSessionResponse,
} from "@sentropic/remote-protocol";
import type { Ajv } from "ajv";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { AgentRegistry } from "../agents/registry.js";
import { SessionEventBus } from "../sessions/events.js";
import { SessionStore } from "../sessions/store.js";
import {
  authEnabled,
  mintSessionToken,
  sessionTokenSecret,
} from "../auth/session-token.js";
import {
  StubTenantProvisioner,
  type TenantProvisioner,
} from "../tenancy/tenant-provisioner.js";
import {
  type ValidationVars,
  validateJsonBody,
  validatedBody,
} from "../validation.js";

function randomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

function buildDescriptor(
  req: CreateSessionRequest & { workspaceId?: string },
): SessionDescriptor {
  const now = new Date().toISOString();
  const descriptor: SessionDescriptor = {
    id: randomId("sess"),
    profile: req.profile,
    target: req.target,
    workspacePath: "/workspace",
    createdAt: now,
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };

  if (req.workspaceId !== undefined) descriptor.workspaceId = req.workspaceId;
  if (req.displayName !== undefined) descriptor.displayName = req.displayName;
  if (req.labels !== undefined) descriptor.labels = req.labels;
  if (req.resourceLimits !== undefined)
    descriptor.resourceLimits = req.resourceLimits;
  if (req.requiredCapabilities !== undefined)
    descriptor.requiredCapabilities = req.requiredCapabilities;
  if (req.metadata !== undefined) descriptor.metadata = req.metadata;

  return descriptor;
}

function notFound(c: { json: (body: unknown, status: number) => Response }) {
  return c.json(
    {
      code: "session.not_found",
      message: "Session not found",
      retryable: false,
    },
    404,
  );
}

export type SessionsRouterDeps = {
  readonly ajv: Ajv;
  readonly store?: SessionStore;
  readonly bus?: SessionEventBus;
  readonly provisioner?: SessionProvisioner;
  readonly registry?: AgentRegistry;
  readonly tenantProvisioner?: TenantProvisioner;
};

export function createSessionsRouter(
  deps: SessionsRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const ajv = deps.ajv;
  const store = deps.store ?? new SessionStore();
  const bus = deps.bus ?? new SessionEventBus();
  const provisioner = deps.provisioner ?? new InMemoryProvisioner();
  const registry = deps.registry ?? new AgentRegistry();
  const tenantProvisioner = deps.tenantProvisioner ?? new StubTenantProvisioner();

  const router = new Hono<{ Variables: ValidationVars }>();

  const workspaceArchives = new Map<string, Uint8Array>();
  const workspaceExports = new Map<string, Uint8Array>();
  // Owner + tenant namespace captured at create time so the terminal.exited
  // cascade (which fires outside any request) can destroy in the right
  // namespace and delete from the right user partition.
  const sessionTenant = new Map<string, { userId: string; namespace: string }>();

  const emit: ProvisionerEmit = (sessionId, type, payload) => {
    bus.publish(sessionId, type, payload);
  };

  const controlPlaneActor = {
    id: "control-plane",
    kind: "control-plane" as const,
    displayName: "Control Plane",
  };

  function buildTerminalInputEnvelope(
    sessionId: string,
    payload: Record<string, unknown>,
  ): RemoteEventEnvelope {
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: randomId("evt"),
      sessionId,
      sequence: 0,
      type: "terminal.input",
      occurredAt: new Date().toISOString(),
      correlationId: `op-${randomId("input")}`,
      actor: controlPlaneActor,
      payload,
    };
  }

  function buildTerminalResizeEnvelope(
    sessionId: string,
    payload: Record<string, unknown>,
  ): RemoteEventEnvelope {
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: randomId("evt"),
      sessionId,
      sequence: 0,
      type: "terminal.resized",
      occurredAt: new Date().toISOString(),
      correlationId: `op-${randomId("resize")}`,
      actor: controlPlaneActor,
      payload,
    };
  }

  function stopSessionInternal(
    id: string,
    reason: string | undefined,
    userId?: string,
  ): boolean {
    const tenant = sessionTenant.get(id);
    // Enforce ownership when a userId is supplied (request-scoped stop). The
    // terminal.exited cascade calls without one (system-scoped).
    if (userId !== undefined && tenant && tenant.userId !== userId) return false;
    if (!store.get(id, userId)) return false;
    store.delete(id, userId);
    sessionTenant.delete(id);
    workspaceArchives.delete(id);
    workspaceExports.delete(id);
    void provisioner
      .destroy(id, emit, tenant?.namespace)
      .catch((error: unknown) => {
        console.error(
          `[control-plane] session destroy failed (${reason ?? "unspecified"}):`,
          error,
        );
      })
      .finally(() => bus.forget(id));
    return true;
  }

  function watchForTerminalExited(sessionId: string): void {
    const unsubscribe = bus.subscribe(
      sessionId,
      (envelope) => {
        if (envelope.type !== "terminal.exited") return;
        unsubscribe();
        // Defer the destroy so the SSE subscribers see the exit event first.
        setImmediate(() => {
          if (!store.get(sessionId)) return;
          stopSessionInternal(sessionId, "terminal.exited");
        });
      },
      { replay: false },
    );
  }

  router.post(
    "/",
    validateJsonBody(ajv, createSessionRequestSchema),
    async (c) => {
      const req = validatedBody<
        CreateSessionRequest & {
          credentials?: Record<string, string>;
          workspaceSync?: boolean;
          workspaceExport?: boolean;
          workspaceId?: string;
        }
      >(c);
      const { userId } = c.var.auth!;
      const { namespace } = await tenantProvisioner.ensureTenant(userId);
      const descriptor = store.put(buildDescriptor(req), userId);
      sessionTenant.set(descriptor.id, { userId, namespace });
      bus.publish(descriptor.id, "session.lifecycle.changed", {
        nextState: "requested",
      });
      watchForTerminalExited(descriptor.id);
      const provisionOptions: {
        credentials?: Record<string, string>;
        workspaceSync?: boolean;
        workspaceExport?: boolean;
        namespace?: string;
        sessionToken?: string;
      } = { namespace };
      if (req.credentials) provisionOptions.credentials = req.credentials;
      if (req.workspaceSync) provisionOptions.workspaceSync = true;
      if (req.workspaceExport) provisionOptions.workspaceExport = true;
      // Under bearer auth, mint a per-session service token the agent uses to
      // authenticate its callbacks (workspace sync/export, cli-session). In
      // off-mode no secret/auth is set so nothing is minted or injected.
      const secret = sessionTokenSecret();
      if (authEnabled() && secret) {
        provisionOptions.sessionToken = await mintSessionToken({
          userId,
          sessionId: descriptor.id,
          secret,
        });
      }
      void provisioner.provision(descriptor, emit, provisionOptions);
      const response: CreateSessionResponse = { session: descriptor };
      return c.json(response, 201);
    },
  );

  // Workspace archive staging: the CLI uploads a tar.gz of the cwd here after
  // session creation; the session-agent fetches it (with retry) on startup and
  // extracts it into /workspace. Held in memory, dropped on stop.
  router.post("/:id/workspace", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) {
      return c.json(
        { code: "workspace.empty", message: "Empty archive", retryable: false },
        400,
      );
    }
    workspaceArchives.set(id, body);
    return c.json({ sessionId: id, bytes: body.byteLength, accepted: true });
  });

  router.get("/:id/workspace", (c) => {
    const id = c.req.param("id");
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const archive = workspaceArchives.get(id);
    if (!archive) return notFound(c);
    return new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
  });

  // Workspace export: the session-agent tars /workspace and POSTs it here; the
  // CLI (remote workspace pull) GETs it. Held in memory, dropped on stop.
  router.post("/:id/workspace/export", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const body = new Uint8Array(await c.req.arrayBuffer());
    workspaceExports.set(id, body);
    return c.json({ sessionId: id, bytes: body.byteLength, accepted: true });
  });

  router.get("/:id/workspace/export", (c) => {
    const id = c.req.param("id");
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const archive = workspaceExports.get(id);
    if (!archive) return notFound(c);
    return new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
  });

  // The session-agent reports the wrapped CLI's own conversation id once it
  // detects it (newest file in the profile's conversation dir).
  router.post("/:id/cli-session", async (c) => {
    const id = c.req.param("id");
    const userId = c.var.auth!.userId;
    const session = store.get(id, userId);
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      cliSessionId?: string;
    };
    if (typeof body.cliSessionId === "string" && body.cliSessionId.length > 0) {
      store.put({ ...session, cliSessionId: body.cliSessionId }, userId);
    }
    return c.json({ sessionId: id, accepted: true });
  });

  router.get("/", (c) => {
    const response: ListSessionsResponse = {
      sessions: store.list(c.var.auth!.userId),
    };
    return c.json(response);
  });

  router.get("/:id", (c) => {
    const session = store.get(c.req.param("id"), c.var.auth!.userId);
    if (!session) return notFound(c);
    const response: GetSessionResponse = { session };
    return c.json(response);
  });

  router.post(
    "/:id/credentials",
    validateJsonBody(ajv, refreshSessionCredentialsRequestSchema),
    async (c) => {
      const id = c.req.param("id");
      const userId = c.var.auth!.userId;
      const descriptor = store.get(id, userId);
      if (!descriptor) return notFound(c);
      const body = validatedBody<RefreshSessionCredentialsRequest>(c);
      const refreshOptions: {
        credentials: RefreshSessionCredentialsRequest;
        namespace?: string;
      } = { credentials: body };
      const namespace = sessionTenant.get(id)?.namespace;
      if (namespace !== undefined) refreshOptions.namespace = namespace;
      await provisioner.refresh(descriptor, emit, refreshOptions);
      const response: RefreshSessionCredentialsResponse = {
        sessionId: id,
        accepted: true,
      };
      return c.json(response);
    },
  );

  router.post(
    "/:id/stop",
    validateJsonBody(ajv, stopSessionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      const req = validatedBody<StopSessionRequest>(c);
      const stopped = stopSessionInternal(id, req.reason, c.var.auth!.userId);
      if (!stopped) return notFound(c);
      const response: StopSessionResponse = { sessionId: id, accepted: true };
      return c.json(response);
    },
  );

  router.post(
    "/:id/instructions",
    validateJsonBody(ajv, sendInstructionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const req = validatedBody<SendInstructionRequest>(c);
      const instructionId = randomId("inst");
      const payload: Record<string, unknown> = {
        instructionId,
        instruction: req.instruction,
      };
      if (req.correlationId !== undefined)
        payload.correlationId = req.correlationId;
      if (req.metadata !== undefined) payload.metadata = req.metadata;
      bus.publish(id, "session.instruction.received", payload, {
        ...(req.correlationId !== undefined
          ? { correlationId: req.correlationId }
          : {}),
      });
      const response: SendInstructionResponse = {
        instructionId,
        accepted: true,
      };
      return c.json(response, 202);
    },
  );

  router.post(
    "/:id/terminal/input",
    validateJsonBody(ajv, terminalInputSchema),
    (c) => {
      const id = c.req.param("id");
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const body = validatedBody<Record<string, unknown>>(c);
      const envelope = buildTerminalInputEnvelope(id, body);
      const delivered = registry.send(id, envelope);
      if (!delivered) {
        return c.json(
          {
            code: "terminal.unavailable",
            message: "No session-agent connected",
            retryable: true,
          },
          503,
        );
      }
      return c.json({ accepted: true }, 202);
    },
  );

  router.post(
    "/:id/terminal/resize",
    validateJsonBody(ajv, terminalResizeSchema),
    (c) => {
      const id = c.req.param("id");
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const body = validatedBody<Record<string, unknown>>(c);
      const envelope = buildTerminalResizeEnvelope(id, body);
      const delivered = registry.send(id, envelope);
      if (!delivered) {
        return c.json(
          {
            code: "terminal.unavailable",
            message: "No session-agent connected",
            retryable: true,
          },
          503,
        );
      }
      return c.json({ accepted: true }, 202);
    },
  );

  router.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);

    const queue: RemoteEventEnvelope[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = bus.subscribe(id, (envelope) => {
      queue.push(envelope);
      const wake = notify;
      notify = null;
      wake?.();
    });

    return streamSSE(c, async (stream) => {
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          while (queue.length > 0 && !stream.aborted) {
            const envelope = queue.shift();
            if (!envelope) break;
            await stream.writeSSE({
              event: envelope.type,
              data: JSON.stringify(envelope),
              id: envelope.eventId,
            });
          }
          if (stream.aborted) break;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return router;
}
