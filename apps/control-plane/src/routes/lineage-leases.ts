/**
 * lineage-leases.ts — Phase A0b
 *
 * Hono router exposing the lease/fencing operations from lineage-lease.ts
 * over HTTP. Validates all request bodies with Ajv JSON Schema.
 *
 * Routes:
 *   POST   /lineage-leases/acquire       — acquire or take-over an expired lease
 *   POST   /lineage-leases/:id/renew     — push expiry forward (same holder + epoch)
 *   POST   /lineage-leases/:id/handoff   — hand off to new holder (increments epoch)
 *   DELETE /lineage-leases/:id           — release (delete) a held lease
 *   GET    /lineage-leases/:id           — read current lease (no mutation)
 */

import type { Ajv } from "ajv";
import { Hono } from "hono";

import {
  acquireLease,
  handoffLease,
  readLease,
  releaseLease,
  renewLease,
  type LineageId,
  type LineageLease,
} from "../lineage-lease.js";
import {
  type ValidationVars,
  validateJsonBody,
  validatedBody,
} from "../validation.js";

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const acquireSchema = {
  $id: "lineage-leases/acquire",
  type: "object",
  required: ["lineageId", "holder", "incarnationId", "location"],
  additionalProperties: false,
  properties: {
    lineageId: { type: "string" },
    holder: { type: "string" },
    incarnationId: { type: "string" },
    location: { type: "string", enum: ["local", "remote"] },
    ttlMs: { type: "number" },
  },
} as const;

const renewSchema = {
  $id: "lineage-leases/renew",
  type: "object",
  required: ["holder", "expectedEpoch"],
  additionalProperties: false,
  properties: {
    holder: { type: "string" },
    expectedEpoch: { type: "number" },
    ttlMs: { type: "number" },
  },
} as const;

const handoffSchema = {
  $id: "lineage-leases/handoff",
  type: "object",
  required: [
    "fromHolder",
    "expectedEpoch",
    "toHolder",
    "toIncarnationId",
    "toLocation",
  ],
  additionalProperties: false,
  properties: {
    fromHolder: { type: "string" },
    expectedEpoch: { type: "number" },
    toHolder: { type: "string" },
    toIncarnationId: { type: "string" },
    toLocation: { type: "string", enum: ["local", "remote"] },
    ttlMs: { type: "number" },
  },
} as const;

const releaseSchema = {
  $id: "lineage-leases/release",
  type: "object",
  required: ["holder", "expectedEpoch"],
  additionalProperties: false,
  properties: {
    holder: { type: "string" },
    expectedEpoch: { type: "number" },
  },
} as const;

// ---------------------------------------------------------------------------
// Request body types (derived from schemas)
// ---------------------------------------------------------------------------

type AcquireBody = {
  lineageId: string;
  holder: string;
  incarnationId: string;
  location: "local" | "remote";
  ttlMs?: number;
};

type RenewBody = {
  holder: string;
  expectedEpoch: number;
  ttlMs?: number;
};

type HandoffBody = {
  fromHolder: string;
  expectedEpoch: number;
  toHolder: string;
  toIncarnationId: string;
  toLocation: "local" | "remote";
  ttlMs?: number;
};

type ReleaseBody = {
  holder: string;
  expectedEpoch: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type LineageLeasesRouterDeps = {
  readonly ajv: Ajv;
};

export function createLineageLeasesRouter(
  deps: LineageLeasesRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const { ajv } = deps;
  const router = new Hono<{ Variables: ValidationVars }>();

  // leaseRoot from DATA_DIR env (evaluated at request time so tests can set it).
  function leaseRoot(): string {
    return process.env.DATA_DIR ?? process.cwd();
  }

  // POST /acquire
  router.post(
    "/acquire",
    validateJsonBody(ajv, acquireSchema),
    (c) => {
      const body = validatedBody<AcquireBody>(c);
      const result = acquireLease(
        body.lineageId as LineageId,
        body.holder,
        body.incarnationId,
        body.location,
        body.ttlMs ?? 60_000,
        leaseRoot(),
      );
      if ("error" in result) {
        return c.json(
          { error: "conflict", current: result.current },
          409,
        );
      }
      return c.json(result as LineageLease, 200);
    },
  );

  // POST /:id/renew
  router.post(
    "/:id/renew",
    validateJsonBody(ajv, renewSchema),
    (c) => {
      const id = c.req.param("id") as LineageId;
      const body = validatedBody<RenewBody>(c);
      const result = renewLease(
        id,
        body.holder,
        body.expectedEpoch,
        body.ttlMs ?? 60_000,
        leaseRoot(),
      );
      if ("error" in result) {
        return c.json({ error: result.error }, 409);
      }
      return c.json(result as LineageLease, 200);
    },
  );

  // POST /:id/handoff
  router.post(
    "/:id/handoff",
    validateJsonBody(ajv, handoffSchema),
    (c) => {
      const id = c.req.param("id") as LineageId;
      const body = validatedBody<HandoffBody>(c);
      const result = handoffLease(
        id,
        body.fromHolder,
        body.expectedEpoch,
        body.toHolder,
        body.toIncarnationId,
        body.toLocation,
        body.ttlMs ?? 60_000,
        leaseRoot(),
      );
      if ("error" in result) {
        return c.json({ error: result.error }, 409);
      }
      return c.json(result as LineageLease, 200);
    },
  );

  // DELETE /:id
  router.delete(
    "/:id",
    validateJsonBody(ajv, releaseSchema),
    (c) => {
      const id = c.req.param("id") as LineageId;
      const body = validatedBody<ReleaseBody>(c);
      const result = releaseLease(
        id,
        body.holder,
        body.expectedEpoch,
        leaseRoot(),
      );
      if (result !== undefined && "error" in result) {
        return c.json({ error: result.error }, 409);
      }
      return c.json({ released: true }, 200);
    },
  );

  // GET /:id
  router.get("/:id", (c) => {
    const id = c.req.param("id") as LineageId;
    const lease = readLease(id, leaseRoot());
    if (lease === null) {
      return c.json(
        {
          code: "lease.not_found",
          message: "No lease found for this lineage id",
          retryable: false,
        },
        404,
      );
    }
    return c.json(lease, 200);
  });

  return router;
}
