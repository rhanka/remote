/**
 * lineage-leases-crash.test.ts — Phase A0d
 *
 * HTTP-level crash/sleep/rollout scenarios for the lineage-leases router and
 * the requireLeaseToken middleware.
 *
 *  7. Restart CP sans perte d'autorite (store re-created from file)
 *  8. Token perime via HTTP -> 409 stale_epoch
 *  9. Handoff HTTP puis refus de l'ancien holder -> 409
 * 10. Chemin sync refuse avec token perime (requireLeaseToken middleware) -> 409
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireLeaseToken } from "../middleware/require-lease-token.js";
import { createAjv } from "../validation.js";
import { acquireLease, type LineageId } from "../lineage-lease.js";
import { createLineageLeasesRouter } from "./lineage-leases.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_LINEAGE = "lin_crashcp00112233445566778899" as LineageId;
const HOLDER_A = "claude:remote:crash-holder-a";
const HOLDER_B = "codex:remote:crash-holder-b";
const SHORT_TTL = 50; // 50 ms

function makeRouter(dataDir: string) {
  process.env.DATA_DIR = dataDir;
  const ajv = createAjv();
  return createLineageLeasesRouter({ ajv });
}

async function waitForHttpExpiry(
  app: ReturnType<typeof makeRouter>,
  lineageId: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const res = await app.request(`/${lineageId}`, { method: "GET" });
    if (res.status === 404) return; // released by someone
    const body = (await res.json()) as Record<string, unknown>;
    const expiresAt = body.expiresAt as string | undefined;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Lease did not expire within 2 seconds");
}

// ---------------------------------------------------------------------------
// Test root setup
// ---------------------------------------------------------------------------

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  "..",
  ".test-scratch",
  "lineage-leases-crash",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

let tmpDir: string;
let app: ReturnType<typeof makeRouter>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(SCRATCH_ROOT, "test-"));
  app = makeRouter(tmpDir);
});

afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Restart CP sans perte d'autorite
// ---------------------------------------------------------------------------

describe("restart CP sans perte d'autorite (scenario 7)", () => {
  // Each app.request takes ~1-2s on cold start; these tests make 3-4 requests.
  // Use an explicit 20s timeout to stay well above the 5s default.

  it(
    "recreating the router (simulated restart) reads the lease from file; mutations with correct epoch still succeed",
    async () => {
      // Acquire via the first router instance.
      const acquireRes = await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: 60_000,
        }),
      });
      expect(acquireRes.status).toBe(200);
      const acquired = (await acquireRes.json()) as Record<string, unknown>;
      expect(acquired.epoch).toBe(0);

      // Simulate CP restart: create a brand-new router pointing at the same DATA_DIR.
      // The store is purely file-based so the lease persists on disk.
      const appAfterRestart = makeRouter(tmpDir);

      // Read the lease via the new router — must still be there.
      const getRes = await appAfterRestart.request(`/${TEST_LINEAGE}`, {
        method: "GET",
      });
      expect(getRes.status).toBe(200);
      const lease = (await getRes.json()) as Record<string, unknown>;
      expect(lease.epoch).toBe(0);
      expect(lease.holder).toBe(HOLDER_A);

      // Renew via the new router — mutation with correct epoch must succeed.
      const renewRes = await appAfterRestart.request(`/${TEST_LINEAGE}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0, ttlMs: 120_000 }),
      });
      expect(renewRes.status).toBe(200);
      const renewed = (await renewRes.json()) as Record<string, unknown>;
      expect(renewed.epoch).toBe(0);
      expect(renewed.holder).toBe(HOLDER_A);
    },
    20_000,
  );

  it(
    "recreated router reflects mutations made before restart (epoch increments survive)",
    async () => {
      // Acquire.
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: 60_000,
        }),
      });

      // Handoff (epoch 0->1) on first router.
      await app.request(`/${TEST_LINEAGE}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromHolder: HOLDER_A,
          expectedEpoch: 0,
          toHolder: HOLDER_B,
          toIncarnationId: "inc-002",
          toLocation: "local",
          ttlMs: 60_000,
        }),
      });

      // Simulate restart.
      const appAfterRestart = makeRouter(tmpDir);

      // Verify epoch 1 is visible.
      const getRes = await appAfterRestart.request(`/${TEST_LINEAGE}`, {
        method: "GET",
      });
      const lease = (await getRes.json()) as Record<string, unknown>;
      expect(lease.epoch).toBe(1);
      expect(lease.holder).toBe(HOLDER_B);

      // Old epoch rejected on new router.
      const staleRes = await appAfterRestart.request(`/${TEST_LINEAGE}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0 }),
      });
      expect(staleRes.status).toBe(409);
      const staleBody = (await staleRes.json()) as Record<string, unknown>;
      expect(staleBody.error).toBe("stale_epoch");
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 8. Token perime via HTTP -> 409 stale_epoch
// ---------------------------------------------------------------------------

describe("token perime via HTTP (scenario 8)", () => {
  it(
    "POST /:id/renew with stale epoch after TTL expiry -> 409 stale_epoch or not_holder",
    async () => {
      // Acquire with a short TTL.
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: SHORT_TTL,
        }),
      });

      // Wait for expiry.
      await waitForHttpExpiry(app, TEST_LINEAGE);

      // B takes over the expired lease.
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_B,
          incarnationId: "inc-002",
          location: "remote",
          ttlMs: 60_000,
        }),
      });

      // A tries to renew with its original epoch 0 — wrong holder now.
      // The router returns 409 with a lease error (not_holder since epoch matches
      // but holder is now HOLDER_B).
      const staleRes = await app.request(`/${TEST_LINEAGE}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0, ttlMs: 60_000 }),
      });
      expect(staleRes.status).toBe(409);
      const body = (await staleRes.json()) as Record<string, unknown>;
      // holder mismatch is reported as "not_holder"
      expect(["stale_epoch", "not_holder"]).toContain(body.error as string);
    },
    20_000,
  );

  it("POST /:id/renew with a fully wrong epoch -> 409 stale_epoch", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
        ttlMs: 60_000,
      }),
    });

    const res = await app.request(`/${TEST_LINEAGE}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 99 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
  });
});

// ---------------------------------------------------------------------------
// 9. Handoff HTTP puis refus de l'ancien holder
// ---------------------------------------------------------------------------

describe("handoff HTTP puis refus de l'ancien holder (scenario 9)", () => {
  it(
    "after handoff A->B, A's renew with original epoch -> 409 stale_epoch",
    async () => {
      // Acquire by A.
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: 60_000,
        }),
      });

      // Handoff A -> B (epoch 0 -> 1).
      const handoffRes = await app.request(`/${TEST_LINEAGE}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromHolder: HOLDER_A,
          expectedEpoch: 0,
          toHolder: HOLDER_B,
          toIncarnationId: "inc-002",
          toLocation: "local",
          ttlMs: 60_000,
        }),
      });
      expect(handoffRes.status).toBe(200);
      const handoffBody = (await handoffRes.json()) as Record<string, unknown>;
      expect(handoffBody.epoch).toBe(1);

      // A tries to renew with its original epoch 0 -> 409 stale_epoch.
      const staleRes = await app.request(`/${TEST_LINEAGE}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0 }),
      });
      expect(staleRes.status).toBe(409);
      const staleBody = (await staleRes.json()) as Record<string, unknown>;
      expect(staleBody.error).toBe("stale_epoch");
    },
    20_000,
  );

  it(
    "after handoff A->B, A's handoff attempt also fails with stale_epoch",
    async () => {
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: 60_000,
        }),
      });

      // Legitimate handoff A -> B.
      await app.request(`/${TEST_LINEAGE}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromHolder: HOLDER_A,
          expectedEpoch: 0,
          toHolder: HOLDER_B,
          toIncarnationId: "inc-002",
          toLocation: "local",
          ttlMs: 60_000,
        }),
      });

      // A (stale) tries to do another handoff with epoch 0 — must fail.
      const staleHandoff = await app.request(`/${TEST_LINEAGE}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromHolder: HOLDER_A,
          expectedEpoch: 0,
          toHolder: "evil:holder",
          toIncarnationId: "evil-inc",
          toLocation: "remote",
          ttlMs: 60_000,
        }),
      });
      expect(staleHandoff.status).toBe(409);
      const body = (await staleHandoff.json()) as Record<string, unknown>;
      expect(body.error).toBe("stale_epoch");
    },
    20_000,
  );

  it(
    "B (new holder at epoch 1) can renew normally after handoff",
    async () => {
      await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lineageId: TEST_LINEAGE,
          holder: HOLDER_A,
          incarnationId: "inc-001",
          location: "remote",
          ttlMs: 60_000,
        }),
      });

      await app.request(`/${TEST_LINEAGE}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromHolder: HOLDER_A,
          expectedEpoch: 0,
          toHolder: HOLDER_B,
          toIncarnationId: "inc-002",
          toLocation: "local",
          ttlMs: 60_000,
        }),
      });

      // B renews with epoch 1 — should succeed.
      const renewRes = await app.request(`/${TEST_LINEAGE}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: HOLDER_B, expectedEpoch: 1, ttlMs: 60_000 }),
      });
      expect(renewRes.status).toBe(200);
      const body = (await renewRes.json()) as Record<string, unknown>;
      expect(body.epoch).toBe(1);
      expect(body.holder).toBe(HOLDER_B);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 10. Chemin sync refuse avec token perime (requireLeaseToken middleware)
// ---------------------------------------------------------------------------

describe("chemin sync refuse avec token perime (scenario 10)", () => {
  /**
   * We test the requireLeaseToken middleware directly by mounting it on a
   * minimal Hono route — no need to wire up the full sessions router.
   */
  function makeLeaseMiddlewareApp(dataDir: string): Hono {
    const miniApp = new Hono();
    const leaseRoot = () => dataDir;
    // Simulate /sessions/:id/workspace with requireLeaseToken
    miniApp.post(
      "/sessions/:id/workspace",
      requireLeaseToken(leaseRoot),
      (c) => c.json({ accepted: true }, 200),
    );
    return miniApp;
  }

  it("POST /sessions/:id/workspace with no lineage headers -> passes through (backward compat)", async () => {
    const miniApp = makeLeaseMiddlewareApp(tmpDir);
    const res = await miniApp.request("/sessions/sess-001/workspace", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "data",
    });
    // No lineage header -> middleware passes; miniApp returns 200.
    expect(res.status).toBe(200);
  });

  it("POST /sessions/:id/workspace with X-Lineage-Id for unknown lease -> 404", async () => {
    const miniApp = makeLeaseMiddlewareApp(tmpDir);
    const res = await miniApp.request("/sessions/sess-001/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Lineage-Id": TEST_LINEAGE,
        "X-Lineage-Epoch": "0",
      },
      body: "data",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("lineage.not_found");
  });

  it("POST /sessions/:id/workspace with stale X-Lineage-Epoch after handoff -> 409 stale_epoch", async () => {
    // Write a lease on disk (epoch 0 -> handoff -> epoch 1).
    acquireLease(TEST_LINEAGE, HOLDER_A, "tmux-a", "local", 60_000, tmpDir);

    // Direct handoff using the file-based API.
    const { handoffLease } = await import("../lineage-lease.js");
    handoffLease(TEST_LINEAGE, HOLDER_A, 0, HOLDER_B, "sess-b", "remote", 60_000, tmpDir);

    // The current lease now has epoch=1 on disk.
    const miniApp = makeLeaseMiddlewareApp(tmpDir);

    // Caller presents epoch 0 (stale) -> 409.
    const res = await miniApp.request("/sessions/sess-001/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Lineage-Id": TEST_LINEAGE,
        "X-Lineage-Epoch": "0",
      },
      body: "data",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
    expect(typeof body.currentEpoch).toBe("number");
    expect(body.currentEpoch).toBe(1);
  });

  it("POST /sessions/:id/workspace with correct X-Lineage-Epoch -> passes through", async () => {
    acquireLease(TEST_LINEAGE, HOLDER_B, "sess-b", "remote", 60_000, tmpDir);

    // Lease epoch is 0 after fresh acquire; present it correctly.
    const miniApp = makeLeaseMiddlewareApp(tmpDir);

    const res = await miniApp.request("/sessions/sess-001/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Lineage-Id": TEST_LINEAGE,
        "X-Lineage-Epoch": "0",
      },
      body: "data",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });

  it("POST /sessions/:id/workspace with epoch after short-TTL expiry (peer took over) -> 409", async () => {
    // To produce a stale-epoch mismatch via expiry:
    // 1. A acquires LIN2 at epoch 0.
    // 2. A handoffs to B with short TTL (epoch becomes 1).
    // 3. B's lease expires without renew.
    // 4. C acquires the expired lease (epoch stays at 1).
    // 5. A presents epoch 0 -> stale_epoch (disk has epoch 1).
    const LIN2 = "lin_crashmiddleware000000000099" as LineageId;
    acquireLease(LIN2, HOLDER_A, "tmux-a", "local", 60_000, tmpDir);

    const { handoffLease, readLease } = await import("../lineage-lease.js");
    handoffLease(LIN2, HOLDER_A, 0, HOLDER_B, "sess-b", "remote", SHORT_TTL, tmpDir);

    // Wait for B's lease to expire.
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const l = readLease(LIN2, tmpDir);
      if (l && new Date(l.expiresAt).getTime() <= Date.now()) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // C takes over (acquireLease on expired keeps epoch at 1).
    acquireLease(LIN2, "gemini:local:c", "inc-c", "local", 60_000, tmpDir);

    const miniApp = makeLeaseMiddlewareApp(tmpDir);

    // A presents epoch 0 (stale — disk has epoch 1) -> 409.
    const res = await miniApp.request("/sessions/sess-001/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "X-Lineage-Id": LIN2,
        "X-Lineage-Epoch": "0",
      },
      body: "data",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
    expect(body.currentEpoch).toBe(1);
  });
});
