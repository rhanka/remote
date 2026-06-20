/**
 * lineage-lease.test.ts — control-plane
 *
 * Unit tests for the CP-local copy of lineage-lease.ts (Phase A0a).
 * Mirrors packages/remote-cli/src/lineage-lease.test.ts but excludes
 * Phase A0c suspension functions (not present in the CP copy).
 * CP signatures: renewLease(id, holder, epoch, ttl, root)
 *                handoffLease(id, fromHolder, epoch, toHolder, toIncarnId, toLoc, ttl, root)
 *                releaseLease(id, holder, epoch, root)
 *                createLineage(profile, kind, wsHex, root)  ← no lineageId param
 *
 * All tests use a real scratch directory (.test-scratch/lineage-lease-cp/)
 * under the package dir — never /tmp.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireLease,
  createLineage,
  handoffLease,
  isLeaseExpired,
  listLineages,
  readLease,
  readLineage,
  releaseLease,
  renewLease,
  updateLineage,
} from "./lineage-lease.js";
import type { LineageId, LineageLease } from "./lineage-lease.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "lineage-lease-cp",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(SCRATCH_ROOT, "test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const LINID = "lin_abc123" as LineageId;
const TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// isLeaseExpired — pure date comparison
// ---------------------------------------------------------------------------

describe("isLeaseExpired", () => {
  function stubLease(expiresAt: string): LineageLease {
    return {
      lineageId: LINID,
      epoch: 0,
      holder: "h",
      incarnationId: "i",
      location: "local",
      expiresAt,
    };
  }

  it("returns false for a future expiresAt", () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    expect(isLeaseExpired(stubLease(future))).toBe(false);
  });

  it("returns true for a past expiresAt", () => {
    const past = new Date(Date.now() - 1).toISOString();
    expect(isLeaseExpired(stubLease(past))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

describe("acquireLease", () => {
  it("creates a lease from scratch at epoch 0", () => {
    const result = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected error");
    expect(result.epoch).toBe(0);
    expect(result.holder).toBe("holder-A");
    expect(result.location).toBe("local");
  });

  it("returns { error: 'conflict' } when a non-expired lease is held", () => {
    acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    const second = acquireLease(LINID, "holder-B", "slug-2", "remote", TTL_MS, root);
    expect("error" in second && second.error).toBe("conflict");
  });

  it("takes over an expired lease (same epoch, new holder)", () => {
    // Acquire with a 0ms TTL — immediately expired
    acquireLease(LINID, "holder-A", "slug-1", "local", 0, root);
    const second = acquireLease(LINID, "holder-B", "slug-2", "remote", TTL_MS, root);
    expect("error" in second).toBe(false);
    if ("error" in second) throw new Error("unexpected error");
    expect(second.holder).toBe("holder-B");
  });

  it("readLease reflects the written lease", () => {
    acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    const lease = readLease(LINID, root);
    expect(lease).not.toBeNull();
    expect(lease?.holder).toBe("holder-A");
  });
});

// ---------------------------------------------------------------------------
// renewLease (lineageId, holder, expectedEpoch, ttlMs, root)
// ---------------------------------------------------------------------------

describe("renewLease", () => {
  it("extends the expiry and returns the updated lease", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    const renewed = renewLease(LINID, "holder-A", acquired.epoch, TTL_MS * 2, root);
    expect("error" in renewed).toBe(false);
    if ("error" in renewed) throw new Error("unexpected error");
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
      new Date(acquired.expiresAt).getTime(),
    );
  });

  it("returns { error: 'stale_epoch' } for a stale epoch", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    const result = renewLease(LINID, "holder-A", acquired.epoch + 1, TTL_MS, root);
    expect("error" in result && result.error).toBe("stale_epoch");
  });
});

// ---------------------------------------------------------------------------
// handoffLease (id, fromHolder, expectedEpoch, toHolder, toIncarnId, toLoc, ttlMs, root)
// ---------------------------------------------------------------------------

describe("handoffLease", () => {
  it("hands off the lease: epoch increments, new holder/location", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    const handoff = handoffLease(
      LINID,
      "holder-A",
      acquired.epoch,
      "holder-B",
      "session-2",
      "remote",
      TTL_MS,
      root,
    );
    expect("error" in handoff).toBe(false);
    if ("error" in handoff) throw new Error("unexpected error");
    expect(handoff.epoch).toBe(acquired.epoch + 1);
    expect(handoff.holder).toBe("holder-B");
    expect(handoff.location).toBe("remote");
  });

  it("rejects stale epoch on handoff", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    const result = handoffLease(
      LINID,
      "holder-A",
      acquired.epoch + 1,
      "holder-B",
      "session-2",
      "remote",
      TTL_MS,
      root,
    );
    expect("error" in result && result.error).toBe("stale_epoch");
  });

  it("old epoch rejected after handoff (fencing token)", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    handoffLease(
      LINID,
      "holder-A",
      acquired.epoch,
      "holder-B",
      "session-2",
      "remote",
      TTL_MS,
      root,
    );
    // Original holder tries to renew with old epoch → stale
    const stale = renewLease(LINID, "holder-A", acquired.epoch, TTL_MS, root);
    expect("error" in stale && stale.error).toBe("stale_epoch");
  });
});

// ---------------------------------------------------------------------------
// releaseLease (lineageId, holder, expectedEpoch, root)
// ---------------------------------------------------------------------------

describe("releaseLease", () => {
  it("deletes the lease file (readLease returns null after)", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    releaseLease(LINID, "holder-A", acquired.epoch, root);
    expect(readLease(LINID, root)).toBeNull();
  });

  it("is idempotent when called twice", () => {
    const acquired = acquireLease(LINID, "holder-A", "slug-1", "local", TTL_MS, root);
    if ("error" in acquired) throw new Error("unexpected error");
    releaseLease(LINID, "holder-A", acquired.epoch, root);
    // Second call should not throw
    expect(() => releaseLease(LINID, "holder-A", acquired.epoch, root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createLineage / readLineage / updateLineage / listLineages
// createLineage(profile, kind, wsHex, root) → generates lineageId internally
// ---------------------------------------------------------------------------

describe("lineage CRUD", () => {
  it("createLineage → readLineage round-trips", () => {
    const rec = createLineage("claude", "local", "ws:abc", root);
    expect(rec.lineage).toMatch(/^lin_/);
    const read = readLineage(rec.lineage, root);
    expect(read).not.toBeNull();
    expect(read?.profile).toBe("claude");
    expect(read?.kind).toBe("local");
    expect(read?.wsHistory).toEqual(["ws:abc"]);
  });

  it("updateLineage changes the patched field and preserves immutable fields", () => {
    const rec = createLineage("claude", "local", "ws:abc", root);
    updateLineage(rec.lineage, { kind: "remote" }, root);
    const after = readLineage(rec.lineage, root);
    expect(after?.kind).toBe("remote");
    // Immutable fields must not change
    expect(after?.lineage).toBe(rec.lineage);
    expect(after?.createdAt).toBe(rec.createdAt);
    expect(after?.profile).toBe("claude");
  });

  it("listLineages returns all lineage records", () => {
    const r1 = createLineage("claude", "local", "ws:a", root);
    const r2 = createLineage("codex", "remote", "ws:b", root);
    const list = listLineages(root);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.lineage).sort()).toEqual(
      [r1.lineage, r2.lineage].sort(),
    );
  });

  it("listLineages returns empty array when no lineages exist", () => {
    expect(listLineages(root)).toEqual([]);
  });
});
