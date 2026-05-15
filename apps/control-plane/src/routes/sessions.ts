import {
  InMemoryProvisioner,
  type ProvisionerEmit,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
  createSessionRequestSchema,
  sendInstructionRequestSchema,
  stopSessionRequestSchema,
  terminalInputSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
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

function buildDescriptor(req: CreateSessionRequest): SessionDescriptor {
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
};

export function createSessionsRouter(
  deps: SessionsRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const ajv = deps.ajv;
  const store = deps.store ?? new SessionStore();
  const bus = deps.bus ?? new SessionEventBus();
  const provisioner = deps.provisioner ?? new InMemoryProvisioner();
  const registry = deps.registry ?? new AgentRegistry();

  const router = new Hono<{ Variables: ValidationVars }>();

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

  router.post("/", validateJsonBody(ajv, createSessionRequestSchema), (c) => {
    const req = validatedBody<
      CreateSessionRequest & {
        credentials?: Record<string, string>;
      }
    >(c);
    const descriptor = store.put(buildDescriptor(req));
    bus.publish(descriptor.id, "session.lifecycle.changed", {
      nextState: "requested",
    });
    const provisionOptions = req.credentials
      ? { credentials: req.credentials }
      : {};
    void provisioner.provision(descriptor, emit, provisionOptions);
    const response: CreateSessionResponse = { session: descriptor };
    return c.json(response, 201);
  });

  router.get("/", (c) => {
    const response: ListSessionsResponse = { sessions: store.list() };
    return c.json(response);
  });

  router.get("/:id", (c) => {
    const session = store.get(c.req.param("id"));
    if (!session) return notFound(c);
    const response: GetSessionResponse = { session };
    return c.json(response);
  });

  router.post(
    "/:id/stop",
    validateJsonBody(ajv, stopSessionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      const session = store.get(id);
      if (!session) return notFound(c);
      validatedBody<StopSessionRequest>(c);
      store.delete(id);
      void provisioner.destroy(id, emit);
      const response: StopSessionResponse = { sessionId: id, accepted: true };
      return c.json(response);
    },
  );

  router.post(
    "/:id/instructions",
    validateJsonBody(ajv, sendInstructionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      if (!store.get(id)) return notFound(c);
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
      if (!store.get(id)) return notFound(c);
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

  router.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return notFound(c);

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
