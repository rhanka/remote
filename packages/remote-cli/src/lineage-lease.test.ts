/**
 * lineage-lease.test.ts — Phase A0a
 *
 * All tests use a real tmpdir (via vitest's tmp helpers / os.tmpdir()) for the
 * filesystem ops, so they are hermetic and require no mocking.
 *
 * Scenarios covered:
 *  1. acquire → read → renew (happy path)
 *  2. acquire when active non-expired lease → { error: "conflict" }
 *  3. acquire when lease expired → succeeds (takes the lease)
 *  4. renew with wrong epoch → { error: "stale_epoch" } (zombie of revival)
 *  5. handoff → epoch+1, new holder; old epoch rejected → { error: "stale_epoch" }
 *  6. two concurrent holders (simulated): only first acquire wins
 *  7. release → readLease returns null
 *  8. createLineage → readLineage → updateLineage → listLineages
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireLease,
  createLineage,
  handoffLease,
  isIncarnationSuspended,
  isLeaseExpired,
  listLineages,
  readLease,
  readLineage,
  releaseLease,
  renewLease,
  resumeLocalIncarnation,
  suspendLocalIncarnation,
  updateLineage,
  type LineageId,
  type LineageLease,
} from "./lineage-lease.js";

// ---------------------------------------------------------------------------
// Test root — fresh temp dir for every test
// ---------------------------------------------------------------------------

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "lineage-lease-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// Helpers
const LIN = "lin_aabbcc001122334455667788" as LineageId;
const LIN2 = "lin_aabbcc009900112233445566" as LineageId;
const HOLDER_A = "claude:local:aaa";
const HOLDER_B = "claude:remote:bbb";
const TTL = 60_000; // 60 s

// ---------------------------------------------------------------------------
// 1. acquire → read → renew (happy path)
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("acquire creates a lease, readLease returns it, renew refreshes expiresAt", () => {
    const acquired = acquireLease(LIN, HOLDER_A, "my-tmux", "local", TTL, testRoot);
    expect("error" in acquired).toBe(false);
    const lease = acquired as LineageLease;

    expect(lease.lineageId).toBe(LIN);
    expect(lease.holder).toBe(HOLDER_A);
    expect(lease.incarnationId).toBe("my-tmux");
    expect(lease.location).toBe("local");
    expect(lease.epoch).toBe(0);
    expect(isLeaseExpired(lease)).toBe(false);

    // Read back from disk
    const read = readLease(LIN, testRoot);
    expect(read).not.toBeNull();
    expect(read!.epoch).toBe(0);
    expect(read!.holder).toBe(HOLDER_A);

    // Renew
    const before = new Date(lease.expiresAt).getTime();
    const renewed = renewLease(LIN, HOLDER_A, 0, TTL * 2, testRoot);
    expect("error" in renewed).toBe(false);
    const r = renewed as LineageLease;
    expect(r.epoch).toBe(0); // epoch unchanged on renew
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. acquire when active non-expired lease → { error: "conflict" }
// ---------------------------------------------------------------------------

describe("conflict", () => {
  it("second acquire while lease is active returns conflict with current", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const result = acquireLease(LIN, HOLDER_B, "sess-b", "remote", TTL, testRoot);
    expect("error" in result).toBe(true);
    const err = result as { error: "conflict"; current: LineageLease };
    expect(err.error).toBe("conflict");
    expect(err.current.holder).toBe(HOLDER_A);
  });
});

// ---------------------------------------------------------------------------
// 3. acquire when lease expired → succeeds
// ---------------------------------------------------------------------------

describe("expired lease take-over", () => {
  it("acquire succeeds and resets holder when the existing lease is expired", () => {
    // Acquire with a 1ms TTL so it immediately expires
    const first = acquireLease(LIN, HOLDER_A, "tmux-a", "local", 1, testRoot) as LineageLease;
    expect(first.epoch).toBe(0);

    // Spin until expired (should be nearly instant)
    // eslint-disable-next-line no-constant-condition
    while (!isLeaseExpired(readLease(LIN, testRoot)!)) { /* busy wait */ }

    const second = acquireLease(LIN, HOLDER_B, "sess-b", "remote", TTL, testRoot);
    expect("error" in second).toBe(false);
    const lease = second as LineageLease;
    expect(lease.holder).toBe(HOLDER_B);
    // epoch kept from previous (no increment on expire-and-take)
    expect(lease.epoch).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. renew with wrong epoch → { error: "stale_epoch" }
// ---------------------------------------------------------------------------

describe("stale epoch on renew", () => {
  it("renewLease with wrong epoch returns stale_epoch (zombie revival)", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const result = renewLease(LIN, HOLDER_A, 99, TTL, testRoot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("stale_epoch");
  });

  it("renewLease with wrong holder returns not_holder", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const result = renewLease(LIN, HOLDER_B, 0, TTL, testRoot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("not_holder");
  });

  it("renewLease when no lease exists returns stale_epoch", () => {
    const result = renewLease(LIN, HOLDER_A, 0, TTL, testRoot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("stale_epoch");
  });
});

// ---------------------------------------------------------------------------
// 5. handoff → epoch+1, new holder; old epoch rejected
// ---------------------------------------------------------------------------

describe("handoff", () => {
  it("handoffLease increments epoch and transfers holder", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const handoff = handoffLease(
      LIN,
      HOLDER_A,
      0,           // expectedEpoch
      HOLDER_B,
      "sess-b",
      "remote",
      TTL,
      testRoot,
    );

    expect("error" in handoff).toBe(false);
    const h = handoff as LineageLease;
    expect(h.epoch).toBe(1);
    expect(h.holder).toBe(HOLDER_B);
    expect(h.incarnationId).toBe("sess-b");
    expect(h.location).toBe("remote");
  });

  it("old epoch is rejected after handoff (anti split-brain)", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    handoffLease(LIN, HOLDER_A, 0, HOLDER_B, "sess-b", "remote", TTL, testRoot);

    // HOLDER_A tries to renew with old epoch 0 — must be rejected
    const stale = renewLease(LIN, HOLDER_A, 0, TTL, testRoot);
    expect("error" in stale).toBe(true);
    expect((stale as { error: string }).error).toBe("stale_epoch");
  });

  it("handoffLease with wrong epoch returns stale_epoch", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const result = handoffLease(LIN, HOLDER_A, 99, HOLDER_B, "sess-b", "remote", TTL, testRoot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("stale_epoch");
  });

  it("handoffLease with wrong fromHolder returns not_holder", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);

    const result = handoffLease(LIN, HOLDER_B, 0, HOLDER_B, "sess-b", "remote", TTL, testRoot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("not_holder");
  });
});

// ---------------------------------------------------------------------------
// 6. two concurrent holders (simulated): only first wins
// ---------------------------------------------------------------------------

describe("concurrent holders", () => {
  it("only first acquire wins; second sees conflict with first holder's data", () => {
    // Simulate concurrent acquire: A and B both read (no lease), then A writes first
    const a = acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    // B arrives a moment later — not really concurrent, but simulates the losing race
    const b = acquireLease(LIN, HOLDER_B, "sess-b", "remote", TTL, testRoot);

    expect("error" in a).toBe(false);
    expect("error" in b).toBe(true);
    const bErr = b as { error: "conflict"; current: LineageLease };
    expect(bErr.error).toBe("conflict");
    expect(bErr.current.holder).toBe(HOLDER_A);
  });

  it("two lineages can coexist without interfering", () => {
    const r1 = acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    const r2 = acquireLease(LIN2, HOLDER_B, "sess-b", "remote", TTL, testRoot);

    expect("error" in r1).toBe(false);
    expect("error" in r2).toBe(false);
    expect((r1 as LineageLease).lineageId).toBe(LIN);
    expect((r2 as LineageLease).lineageId).toBe(LIN2);
  });
});

// ---------------------------------------------------------------------------
// 7. release → readLease returns null
// ---------------------------------------------------------------------------

describe("release", () => {
  it("releaseLease removes the file; readLease returns null", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    const result = releaseLease(LIN, HOLDER_A, 0, testRoot);
    // void means no error
    expect(result).toBeUndefined();
    expect(readLease(LIN, testRoot)).toBeNull();
  });

  it("release with wrong epoch returns stale_epoch", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    const result = releaseLease(LIN, HOLDER_A, 5, testRoot);
    expect("error" in (result as object)).toBe(true);
    expect((result as { error: string }).error).toBe("stale_epoch");
    // Lease still exists
    expect(readLease(LIN, testRoot)).not.toBeNull();
  });

  it("release with wrong holder returns not_holder", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    const result = releaseLease(LIN, HOLDER_B, 0, testRoot);
    expect("error" in (result as object)).toBe(true);
    expect((result as { error: string }).error).toBe("not_holder");
  });

  it("double release is idempotent", () => {
    acquireLease(LIN, HOLDER_A, "tmux-a", "local", TTL, testRoot);
    releaseLease(LIN, HOLDER_A, 0, testRoot);
    // Second release — no lease file, should not throw
    const result = releaseLease(LIN, HOLDER_A, 0, testRoot);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. createLineage → readLineage → updateLineage → listLineages
// ---------------------------------------------------------------------------

describe("lineage CRUD", () => {
  it("createLineage persists and readLineage retrieves it", () => {
    const rec = createLineage("claude", "local", "ws:abc123", testRoot);

    expect(rec.lineage).toMatch(/^lin_/);
    expect(rec.profile).toBe("claude");
    expect(rec.kind).toBe("local");
    expect(rec.wsHistory).toEqual(["ws:abc123"]);
    expect(rec.incarnation.local).toBeNull();
    expect(rec.incarnation.remote).toBeNull();

    const read = readLineage(rec.lineage, testRoot);
    expect(read).not.toBeNull();
    expect(read!.lineage).toBe(rec.lineage);
  });

  it("updateLineage patches the record and refreshes updatedAt", async () => {
    const rec = createLineage("codex", "local", "ws:def456", testRoot);
    const before = rec.updatedAt;

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = updateLineage(
      rec.lineage,
      {
        kind: "remote",
        incarnation: { local: null, remote: { sessionId: "sess-xyz" } },
        wsHistory: ["ws:def456", "ws:ghi789"],
      },
      testRoot,
    );

    expect(updated.kind).toBe("remote");
    expect(updated.incarnation.remote?.sessionId).toBe("sess-xyz");
    expect(updated.wsHistory).toEqual(["ws:def456", "ws:ghi789"]);
    expect(updated.createdAt).toBe(rec.createdAt); // immutable
    expect(updated.lineage).toBe(rec.lineage);     // immutable
    expect(updated.updatedAt).not.toBe(before);
  });

  it("updateLineage throws if lineage doesn't exist", () => {
    expect(() =>
      updateLineage("lin_doesnotexist" as LineageId, { profile: "agy" }, testRoot),
    ).toThrow(/lineage not found/);
  });

  it("listLineages returns all records under the directory", () => {
    // Empty
    expect(listLineages(testRoot)).toHaveLength(0);

    const a = createLineage("claude", "local", "ws:aaa", testRoot);
    const b = createLineage("codex", "remote", "ws:bbb", testRoot);

    const all = listLineages(testRoot);
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.lineage).sort();
    expect(ids).toContain(a.lineage);
    expect(ids).toContain(b.lineage);
  });

  it("two lineages from the same workspace can be created (fanout support)", () => {
    const cl = createLineage("claude", "local", "ws:shared", testRoot);
    const cx = createLineage("codex", "local", "ws:shared", testRoot);

    expect(cl.lineage).not.toBe(cx.lineage);
    expect(listLineages(testRoot)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isLeaseExpired
// ---------------------------------------------------------------------------

describe("isLeaseExpired", () => {
  it("returns false for a future expiresAt", () => {
    const lease: LineageLease = {
      lineageId: LIN,
      epoch: 0,
      holder: HOLDER_A,
      incarnationId: "x",
      location: "local",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(isLeaseExpired(lease)).toBe(false);
  });

  it("returns true for a past expiresAt", () => {
    const lease: LineageLease = {
      lineageId: LIN,
      epoch: 0,
      holder: HOLDER_A,
      incarnationId: "x",
      location: "local",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    expect(isLeaseExpired(lease)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// suspendLocalIncarnation / isIncarnationSuspended / resumeLocalIncarnation
// (Phase A0c)
// ---------------------------------------------------------------------------

describe("incarnation suspension", () => {
  it("isIncarnationSuspended returns false before any suspend", () => {
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(false);
  });

  it("suspendLocalIncarnation makes isIncarnationSuspended return true", () => {
    suspendLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(true);
  });

  it("resumeLocalIncarnation removes the sentinel; isIncarnationSuspended returns false", () => {
    suspendLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(true);
    resumeLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(false);
  });

  it("resumeLocalIncarnation is a no-op when not suspended", () => {
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(false);
    // Should not throw.
    resumeLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(false);
  });

  it("suspending LIN does not affect LIN2", () => {
    suspendLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN2, testRoot)).toBe(false);
  });

  it("suspend is idempotent (double suspend does not throw)", () => {
    suspendLocalIncarnation(LIN, testRoot);
    // Second suspend overwrites the file with a fresh timestamp — no error.
    suspendLocalIncarnation(LIN, testRoot);
    expect(isIncarnationSuspended(LIN, testRoot)).toBe(true);
  });
});
