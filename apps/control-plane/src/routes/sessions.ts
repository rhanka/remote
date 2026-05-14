import {
  createSessionRequestSchema,
  sendInstructionRequestSchema,
  stopSessionRequestSchema,
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

export function createSessionsRouter(
  ajv: Ajv,
  store: SessionStore = new SessionStore(),
  bus: SessionEventBus = new SessionEventBus(),
): Hono<{ Variables: ValidationVars }> {
  const router = new Hono<{ Variables: ValidationVars }>();

  router.post("/", validateJsonBody(ajv, createSessionRequestSchema), (c) => {
    const req = validatedBody<CreateSessionRequest>(c);
    const descriptor = store.put(buildDescriptor(req));
    bus.publish(descriptor.id, "session.lifecycle.changed", {
      nextState: "requested",
    });
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
      bus.publish(id, "session.lifecycle.changed", {
        previousState: "running",
        nextState: "stopping",
      });
      store.delete(id);
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
