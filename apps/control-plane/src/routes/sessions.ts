import {
  createSessionRequestSchema,
  sendInstructionRequestSchema,
  stopSessionRequestSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
  type SendInstructionRequest,
  type SendInstructionResponse,
  type SessionDescriptor,
  type StopSessionRequest,
  type StopSessionResponse,
} from "@remote-controle/protocol";
import type { Ajv } from "ajv";
import { Hono } from "hono";

import { SessionStore } from "../sessions/store.js";
import {
  type ValidationVars,
  validateJsonBody,
  validatedBody,
} from "../validation.js";

function generateSessionId(): string {
  const random = Math.floor(Math.random() * 1e10)
    .toString(36)
    .padStart(8, "0");
  return `sess-${random}`;
}

function generateInstructionId(): string {
  const random = Math.floor(Math.random() * 1e10)
    .toString(36)
    .padStart(8, "0");
  return `inst-${random}`;
}

function buildDescriptor(req: CreateSessionRequest): SessionDescriptor {
  const now = new Date().toISOString();
  const descriptor: SessionDescriptor = {
    id: generateSessionId(),
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
): Hono<{ Variables: ValidationVars }> {
  const router = new Hono<{ Variables: ValidationVars }>();

  router.post("/", validateJsonBody(ajv, createSessionRequestSchema), (c) => {
    const req = validatedBody<CreateSessionRequest>(c);
    const descriptor = store.put(buildDescriptor(req));
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
      validatedBody<SendInstructionRequest>(c);
      const response: SendInstructionResponse = {
        instructionId: generateInstructionId(),
        accepted: true,
      };
      return c.json(response, 202);
    },
  );

  return router;
}
