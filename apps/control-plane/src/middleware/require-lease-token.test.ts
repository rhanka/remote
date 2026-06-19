/**
 * require-lease-token.test.ts — Phase A0c
 *
 * Tests for the `requireLeaseToken` opt-in middleware.
 *
 * Scenarios:
 *  1. Header absent → pass through (backward compat)
 *  2. Correct token → pass through
 *  3. Stale epoch → 409 { error: "stale_epoch", currentEpoch }
 *  4. Unknown lineageId → 404
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLease, type LineageId } from "../lineage-lease.js";
import type { ValidationVars } from "../validation.js";
import { requireLeaseToken } from "./require-lease-token.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_LINEAGE = "lin_middleware0000000000000001" as LineageId;
const HOLDER = "claude:local:test-holder";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cp-require-lease-test-"));
}

function makeApp(dataDir: string): Hono<{ Variables: ValidationVars }> {
  const leaseRoot = () => dataDir;
  const app = new Hono<{ Variables: ValidationVars }>();

  // A simple write endpoint protected by the lease middleware.
  app.post(
    "/sessions/:id/workspace",
    requireLeaseToken(leaseRoot),
    (c) => c.json({ ok: true }, 200),
  );

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireLeaseToken middleware", () => {
  let tmpDir: string;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    app = makeApp(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("header absent → passes through (backward compat)", async () => {
    // No X-Lineage-Id header at all.
    const res = await app.request("/sessions/sess-123/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("correct epoch → passes through", async () => {
    // Create a lease at epoch 0.
    acquireLease(TEST_LINEAGE, HOLDER, "inc-001", "local", 60_000, tmpDir);

    const res = await app.request("/sessions/sess-123/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Lineage-Id": TEST_LINEAGE,
        "X-Lineage-Epoch": "0",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("stale epoch → 409 with currentEpoch", async () => {
    acquireLease(TEST_LINEAGE, HOLDER, "inc-001", "local", 60_000, tmpDir);

    const res = await app.request("/sessions/sess-123/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Lineage-Id": TEST_LINEAGE,
        "X-Lineage-Epoch": "99", // stale
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
    expect(body.currentEpoch).toBe(0);
  });

  it("unknown lineageId → 404", async () => {
    // No lease created for this id.
    const res = await app.request("/sessions/sess-123/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Lineage-Id": "lin_doesnotexist000000000000001",
        "X-Lineage-Epoch": "0",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("X-Lineage-Epoch absent but X-Lineage-Id present → 409 (NaN epoch)", async () => {
    acquireLease(TEST_LINEAGE, HOLDER, "inc-001", "local", 60_000, tmpDir);

    const res = await app.request("/sessions/sess-123/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Lineage-Id": TEST_LINEAGE,
        // No X-Lineage-Epoch header
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
  });
});
