/**
 * require-lease-token.ts — Phase A0c
 *
 * Opt-in middleware that enforces the lineage epoch fencing token on write paths.
 *
 * Reads headers:
 *   X-Lineage-Id    — the lineage being mutated
 *   X-Lineage-Epoch — the caller's expected current epoch (as a decimal string)
 *
 * Behaviour:
 *   - Header absent (no X-Lineage-Id) → pass through (backward compat)
 *   - lineageId unknown (no lease on disk) → 404
 *   - epoch mismatch or non-numeric → 409 { error: "stale_epoch", currentEpoch }
 *   - epoch matches → pass through
 *
 * Usage (opt-in per route, NOT global):
 *   router.post("/some-write", requireLeaseToken(leaseRootFn), (c) => { ... });
 */

import type { MiddlewareHandler } from "hono";

import { readLease, type LineageId } from "../lineage-lease.js";

export function requireLeaseToken(
  leaseRoot: () => string,
): MiddlewareHandler {
  return async (c, next) => {
    const lineageId = c.req.header("X-Lineage-Id");

    // No lineage header → backward compat, let it through.
    if (!lineageId) {
      await next();
      return;
    }

    const lease = readLease(lineageId as LineageId, leaseRoot());
    if (lease === null) {
      c.res = c.json(
        {
          code: "lineage.not_found",
          message: "No lease found for this lineage id",
          retryable: false,
        },
        404,
      );
      return;
    }

    const rawEpoch = c.req.header("X-Lineage-Epoch");
    const epoch = rawEpoch !== undefined ? Number(rawEpoch) : NaN;

    if (!Number.isInteger(epoch) || epoch !== lease.epoch) {
      c.res = c.json(
        {
          error: "stale_epoch",
          currentEpoch: lease.epoch,
        },
        409,
      );
      return;
    }

    await next();
  };
}
