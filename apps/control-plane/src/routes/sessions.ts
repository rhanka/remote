import {
  createSessionRequestSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type SessionDescriptor,
} from "@remote-controle/protocol";
import type { Ajv } from "ajv";
import { Hono } from "hono";

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

export function createSessionsRouter(
  ajv: Ajv,
): Hono<{ Variables: ValidationVars }> {
  const router = new Hono<{ Variables: ValidationVars }>();

  router.post("/", validateJsonBody(ajv, createSessionRequestSchema), (c) => {
    const req = validatedBody<CreateSessionRequest>(c);
    const response: CreateSessionResponse = {
      session: buildDescriptor(req),
    };
    return c.json(response, 201);
  });

  return router;
}
