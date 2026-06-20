import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAjv } from "../validation.js";
import { createLineageLeasesRouter } from "./lineage-leases.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  "..",
  ".test-scratch",
  "lineage-leases-http",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

function makeTmpDir(): string {
  return mkdtempSync(join(SCRATCH_ROOT, "test-"));
}

function makeRouter(dataDir: string) {
  process.env.DATA_DIR = dataDir;
  const ajv = createAjv();
  return createLineageLeasesRouter({ ajv });
}

const TEST_LINEAGE = "lin_testlineage0000000000000000001";
const HOLDER_A = "claude:remote:holder-a";
const HOLDER_B = "codex:remote:holder-b";

describe("lineage-leases router", () => {
  let tmpDir: string;
  let app: ReturnType<typeof makeRouter>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    app = makeRouter(tmpDir);
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // GET — read (no mutation)
  // ---------------------------------------------------------------------------

  it("GET /:id → 404 when no lease exists", async () => {
    const res = await app.request(`/${TEST_LINEAGE}`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // POST /acquire
  // ---------------------------------------------------------------------------

  it("POST /acquire → 200 with lease on first acquire", async () => {
    const res = await app.request("/acquire", {
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
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.lineageId).toBe(TEST_LINEAGE);
    expect(body.holder).toBe(HOLDER_A);
    expect(body.epoch).toBe(0);
    expect(typeof body.expiresAt).toBe("string");
  });

  it("POST /acquire → 409 conflict when lease is already held", async () => {
    // First acquire
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
    // Second acquire on same lineage while still held
    const res = await app.request("/acquire", {
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
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("conflict");
    expect(body.current).toBeDefined();
  });

  it("POST /acquire → 400 when body is missing required fields", async () => {
    const res = await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineageId: TEST_LINEAGE }),
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /:id/renew
  // ---------------------------------------------------------------------------

  it("POST /:id/renew → 200 with renewed lease", async () => {
    // Acquire first
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0, ttlMs: 120_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.epoch).toBe(0);
    expect(body.holder).toBe(HOLDER_A);
  });

  it("POST /:id/renew → 409 with stale epoch", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 99 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("stale_epoch");
  });

  // ---------------------------------------------------------------------------
  // POST /:id/handoff
  // ---------------------------------------------------------------------------

  it("POST /:id/handoff → 200 with incremented epoch", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromHolder: HOLDER_A,
        expectedEpoch: 0,
        toHolder: HOLDER_B,
        toIncarnationId: "inc-002",
        toLocation: "local",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.epoch).toBe(1);
    expect(body.holder).toBe(HOLDER_B);
    expect(body.location).toBe("local");
  });

  it("POST /:id/handoff → 409 when not the holder", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromHolder: HOLDER_B, // wrong holder
        expectedEpoch: 0,
        toHolder: "another",
        toIncarnationId: "inc-003",
        toLocation: "remote",
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("not_holder");
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id (release)
  // ---------------------------------------------------------------------------

  it("DELETE /:id → 200 released:true", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.released).toBe(true);
  });

  it("DELETE /:id → 409 with stale epoch", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 5 }),
    });
    expect(res.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // GET /:id — after acquire
  // ---------------------------------------------------------------------------

  it("GET /:id → 200 after acquire", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    const res = await app.request(`/${TEST_LINEAGE}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.lineageId).toBe(TEST_LINEAGE);
    expect(body.holder).toBe(HOLDER_A);
  });

  it("GET /:id → 404 after release", async () => {
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineageId: TEST_LINEAGE,
        holder: HOLDER_A,
        incarnationId: "inc-001",
        location: "remote",
      }),
    });
    await app.request(`/${TEST_LINEAGE}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder: HOLDER_A, expectedEpoch: 0 }),
    });
    const res = await app.request(`/${TEST_LINEAGE}`, { method: "GET" });
    expect(res.status).toBe(404);
  });
});
