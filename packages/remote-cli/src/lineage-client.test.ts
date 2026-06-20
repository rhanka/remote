import { describe, expect, it } from "vitest";
import {
  acquireLineageLease,
  handoffLineageLease,
  leaseHeaders,
  readLineageLease,
  releaseLineageLease,
  renewLineageLease,
  type LineageLease,
} from "./lineage-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const BASE = "https://cp.example.com";

const STUB_LEASE: LineageLease = {
  lineageId: "lin_abc",
  epoch: 0,
  holder: "holder-A",
  incarnationId: "slug-1",
  location: "local",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

// ---------------------------------------------------------------------------
// leaseHeaders
// ---------------------------------------------------------------------------

describe("leaseHeaders", () => {
  it("returns empty object when lease is undefined", () => {
    expect(leaseHeaders(undefined)).toEqual({});
  });

  it("returns X-Lineage-Id and X-Lineage-Epoch headers", () => {
    expect(leaseHeaders({ lineageId: "lin_abc", epoch: 3 })).toEqual({
      "X-Lineage-Id": "lin_abc",
      "X-Lineage-Epoch": "3",
    });
  });

  it("serialises epoch 0 correctly", () => {
    expect(leaseHeaders({ lineageId: "lin_x", epoch: 0 })).toEqual({
      "X-Lineage-Id": "lin_x",
      "X-Lineage-Epoch": "0",
    });
  });
});

// ---------------------------------------------------------------------------
// acquireLineageLease
// ---------------------------------------------------------------------------

describe("acquireLineageLease", () => {
  const body = {
    lineageId: "lin_abc",
    holder: "holder-A",
    incarnationId: "slug-1",
    location: "local" as const,
  };

  it("returns the lease on 200", async () => {
    const result = await acquireLineageLease(
      BASE,
      body,
      mockFetch(200, STUB_LEASE),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected");
    expect(result.lineageId).toBe("lin_abc");
    expect(result.epoch).toBe(0);
  });

  it("returns { error: 'conflict', current } on 409", async () => {
    const result = await acquireLineageLease(
      BASE,
      body,
      mockFetch(409, { error: "conflict", current: STUB_LEASE }),
    );
    expect("error" in result && result.error).toBe("conflict");
    if (!("error" in result)) throw new Error("unexpected");
    expect(result.current.holder).toBe("holder-A");
  });

  it("throws on unexpected error status", async () => {
    await expect(
      acquireLineageLease(BASE, body, mockFetch(500, { error: "server" })),
    ).rejects.toThrow("acquireLineageLease: 500");
  });
});

// ---------------------------------------------------------------------------
// renewLineageLease
// ---------------------------------------------------------------------------

describe("renewLineageLease", () => {
  const renewed = { ...STUB_LEASE, expiresAt: new Date(Date.now() + 120_000).toISOString() };

  it("returns updated lease on 200", async () => {
    const result = await renewLineageLease(
      BASE,
      "lin_abc",
      { holder: "holder-A", expectedEpoch: 0 },
      mockFetch(200, renewed),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(
      new Date(STUB_LEASE.expiresAt).getTime(),
    );
  });

  it("returns { error: 'stale_epoch' } on 409", async () => {
    const result = await renewLineageLease(
      BASE,
      "lin_abc",
      { holder: "holder-A", expectedEpoch: 99 },
      mockFetch(409, { error: "stale_epoch" }),
    );
    expect("error" in result && result.error).toBe("stale_epoch");
  });

  it("throws on unexpected error status", async () => {
    await expect(
      renewLineageLease(
        BASE,
        "lin_abc",
        { holder: "holder-A", expectedEpoch: 0 },
        mockFetch(503, {}),
      ),
    ).rejects.toThrow("renewLineageLease: 503");
  });
});

// ---------------------------------------------------------------------------
// handoffLineageLease
// ---------------------------------------------------------------------------

describe("handoffLineageLease", () => {
  const handoffed = { ...STUB_LEASE, epoch: 1, holder: "holder-B", location: "remote" as const };

  it("returns updated lease with incremented epoch on 200", async () => {
    const result = await handoffLineageLease(
      BASE,
      "lin_abc",
      {
        fromHolder: "holder-A",
        expectedEpoch: 0,
        toHolder: "holder-B",
        toIncarnationId: "sess-xyz",
        toLocation: "remote",
      },
      mockFetch(200, handoffed),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected");
    expect(result.epoch).toBe(1);
    expect(result.holder).toBe("holder-B");
    expect(result.location).toBe("remote");
  });

  it("returns { error: 'stale_epoch' } on 409", async () => {
    const result = await handoffLineageLease(
      BASE,
      "lin_abc",
      {
        fromHolder: "holder-A",
        expectedEpoch: 99,
        toHolder: "holder-B",
        toIncarnationId: "sess-xyz",
        toLocation: "remote",
      },
      mockFetch(409, { error: "stale_epoch" }),
    );
    expect("error" in result && result.error).toBe("stale_epoch");
  });
});

// ---------------------------------------------------------------------------
// releaseLineageLease
// ---------------------------------------------------------------------------

describe("releaseLineageLease", () => {
  it("resolves on 200", async () => {
    await expect(
      releaseLineageLease(
        BASE,
        "lin_abc",
        { holder: "holder-A", expectedEpoch: 0 },
        mockFetch(200, { released: true }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw on 409 (idempotent — already released / stale epoch)", async () => {
    await expect(
      releaseLineageLease(
        BASE,
        "lin_abc",
        { holder: "holder-A", expectedEpoch: 0 },
        mockFetch(409, { error: "stale_epoch" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws on unexpected error status", async () => {
    await expect(
      releaseLineageLease(
        BASE,
        "lin_abc",
        { holder: "holder-A", expectedEpoch: 0 },
        mockFetch(500, {}),
      ),
    ).rejects.toThrow("releaseLineageLease: 500");
  });
});

// ---------------------------------------------------------------------------
// readLineageLease
// ---------------------------------------------------------------------------

describe("readLineageLease", () => {
  it("returns the lease on 200", async () => {
    const result = await readLineageLease(BASE, "lin_abc", mockFetch(200, STUB_LEASE));
    expect(result).not.toBeNull();
    expect(result?.lineageId).toBe("lin_abc");
  });

  it("returns null on 404", async () => {
    const result = await readLineageLease(
      BASE,
      "lin_abc",
      mockFetch(404, { code: "lineage.not_found" }),
    );
    expect(result).toBeNull();
  });

  it("throws on unexpected error status", async () => {
    await expect(
      readLineageLease(BASE, "lin_abc", mockFetch(503, {})),
    ).rejects.toThrow("readLineageLease: 503");
  });
});
