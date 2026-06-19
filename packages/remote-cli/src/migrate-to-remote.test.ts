/**
 * migrate-to-remote.test.ts — Phase A integration tests
 *
 * Tests for the lineage/lease logic that `migrate to-remote` and
 * `migrate to-local` are built on. Rather than going through main() (which
 * requires mocking the entire Commander setup), we test:
 *
 *  1. checkReadiness with a blocker → ready:false, blockers non-empty
 *  2. checkReadiness ok → ready:true (no blockers)
 *  3. to-remote full flow (unit): lineage create → lease acquire → suspend
 *     → handoff (verifying epoch increments)
 *  4. to-local full flow (unit): lineage find with remote → lease acquire → resume
 *
 * These tests are pure filesystem tests — no pods, no network, no CLI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkReadiness } from "./readiness.js";
import {
  acquireLease,
  createLineage,
  handoffLease,
  isIncarnationSuspended,
  listLineages,
  resumeLocalIncarnation,
  suspendLocalIncarnation,
} from "./lineage-lease.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migrate-to-remote-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkReadiness integration with blockers
// ---------------------------------------------------------------------------

describe("checkReadiness — Phase A gate", () => {
  it("returns ready:false + auth blocker when auth fails", () => {
    const spawn = vi.fn().mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (cmd === "remote" && args[0] === "auth") {
          return { pid: 1, output: [], stdout: "", stderr: "", status: 1, signal: null };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { pid: 1, output: [], stdout: "abc123\n", stderr: "", status: 0, signal: null };
        }
        return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
      },
    );

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn as typeof import("node:child_process").spawnSync });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("auth: CLI not authenticated");
  });

  it("returns ready:true when auth ok + git ok", () => {
    const spawn = vi.fn().mockImplementation(
      (_cmd: string, _args: readonly string[]) => ({
        pid: 1,
        output: [],
        stdout: "ok\n",
        stderr: "",
        status: 0,
        signal: null,
      }),
    );

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn as typeof import("node:child_process").spawnSync });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// to-remote flow: lineage + lease + suspend + handoff
// ---------------------------------------------------------------------------

describe("migrate to-remote flow (unit: lineage+lease+suspend+handoff)", () => {
  it("creates lineage, acquires lease, suspends incarnation, hands off", () => {
    const wsHex = "ws:abc123deadbeef";
    const profile = "claude";
    const localHolder = "claude:local:aaa111";
    const remoteHolder = "remote:pod:sess-xyz";
    const remoteSessionId = "sess-xyz";
    const TTL_MS = 300_000;

    // Step 1: create lineage
    const lineage = createLineage(profile, "local", wsHex, testRoot);
    expect(lineage.lineage).toMatch(/^lin_/);
    expect(lineage.wsHistory).toContain(wsHex);

    // Step 2: acquire lease for local holder
    const leaseResult = acquireLease(
      lineage.lineage,
      localHolder,
      "local-slug",
      "local",
      TTL_MS,
      testRoot,
    );
    expect("error" in leaseResult).toBe(false);
    if ("error" in leaseResult) return; // TS narrowing
    expect(leaseResult.holder).toBe(localHolder);
    expect(leaseResult.location).toBe("local");
    const epoch0 = leaseResult.epoch;

    // Step 3: suspend local incarnation (sentinel written before handoff)
    suspendLocalIncarnation(lineage.lineage, testRoot);
    expect(isIncarnationSuspended(lineage.lineage, testRoot)).toBe(true);

    // Step 4: hand off to remote holder (epoch increments)
    const handoffResult = handoffLease(
      lineage.lineage,
      localHolder,
      epoch0,
      remoteHolder,
      remoteSessionId,
      "remote",
      TTL_MS,
      testRoot,
    );
    expect("error" in handoffResult).toBe(false);
    if ("error" in handoffResult) return;
    expect(handoffResult.epoch).toBe(epoch0 + 1);
    expect(handoffResult.holder).toBe(remoteHolder);
    expect(handoffResult.location).toBe("remote");

    // Verify: trying to use old epoch is rejected (zombie-of-revival guard)
    const staleResult = handoffLease(
      lineage.lineage,
      localHolder,
      epoch0, // stale epoch
      "another:holder",
      "another-sess",
      "local",
      TTL_MS,
      testRoot,
    );
    expect("error" in staleResult).toBe(true);
    if (!("error" in staleResult)) return;
    expect(staleResult.error).toBe("stale_epoch");
  });

  it("lease conflict when another holder already has the lease", () => {
    const wsHex = "ws:deadbeef01";
    const lineage = createLineage("claude", "local", wsHex, testRoot);
    const TTL_MS = 60_000;

    // First holder acquires
    const first = acquireLease(
      lineage.lineage,
      "holder-A",
      "slug-a",
      "local",
      TTL_MS,
      testRoot,
    );
    expect("error" in first).toBe(false);

    // Second holder tries to acquire — should get conflict
    const second = acquireLease(
      lineage.lineage,
      "holder-B",
      "slug-b",
      "local",
      TTL_MS,
      testRoot,
    );
    expect("error" in second).toBe(true);
    if (!("error" in second)) return;
    expect(second.error).toBe("conflict");
    expect(second.current.holder).toBe("holder-A");
  });
});

// ---------------------------------------------------------------------------
// to-local flow: find active remote lineage, acquire lease, resume
// ---------------------------------------------------------------------------

describe("migrate to-local flow (unit: lineage find + lease + resume)", () => {
  it("finds lineage with remote incarnation, acquires local lease, resumes", () => {
    const wsHex = "ws:abc456cafebabe";
    const TTL_MS = 300_000;
    const remoteHolder = "remote:pod:sess-001";

    // Set up: lineage with remote incarnation (simulating post-to-remote state)
    const lineage = createLineage("claude", "remote", wsHex, testRoot);

    // Simulate: remote lease was previously acquired by remote holder
    const remoteLeaseResult = acquireLease(
      lineage.lineage,
      remoteHolder,
      "sess-001",
      "remote",
      TTL_MS,
      testRoot,
    );
    expect("error" in remoteLeaseResult).toBe(false);
    if ("error" in remoteLeaseResult) return;

    // Simulate: remote lease expired (to allow local takeover)
    // We do this by forcing acquireLease to behave as if expired:
    // For this test, we set expiresAt in the past directly
    // by releasing and re-acquiring from local.
    // In real usage: the remote lease expires after TTL.
    // Here, we use a 1ms TTL to expire immediately.

    // Re-acquire with fresh short-TTL to simulate expiry:
    const expiredLease = acquireLease(
      lineage.lineage,
      remoteHolder,
      "sess-001",
      "remote",
      1, // 1ms TTL → expires immediately
      testRoot,
    );
    if ("error" in expiredLease) return; // can't test if conflict

    // Wait a tiny bit to let the 1ms TTL expire
    // (not a real sleep — just ensure Date.now() > expiresAt)
    const busyWait = Date.now() + 5;
    while (Date.now() < busyWait) {
      // spin
    }

    // Now the local holder can take over the expired lease
    const localHolder = "claude:local:bbb222";
    const localLease = acquireLease(
      lineage.lineage,
      localHolder,
      "local-slug",
      "local",
      TTL_MS,
      testRoot,
    );
    expect("error" in localLease).toBe(false);
    if ("error" in localLease) return;
    expect(localLease.holder).toBe(localHolder);
    expect(localLease.location).toBe("local");

    // Resume local incarnation (clear sentinel)
    suspendLocalIncarnation(lineage.lineage, testRoot);
    expect(isIncarnationSuspended(lineage.lineage, testRoot)).toBe(true);
    resumeLocalIncarnation(lineage.lineage, testRoot);
    expect(isIncarnationSuspended(lineage.lineage, testRoot)).toBe(false);
  });

  it("listLineages finds lineages with remote incarnation", () => {
    const wsHex = "ws:cafebeef99";

    // Create a lineage where remote is set
    const lineage = createLineage("claude", "remote", wsHex, testRoot);

    // Write a fake incarnation with remote set (simulate post-migration state)
    // by directly creating the JSON (lineage-lease.ts doesn't have updateIncarnation)
    const lineageFile = join(testRoot, ".remote", "lineages", `${lineage.lineage}.json`);
    const record = {
      ...lineage,
      incarnation: { local: null, remote: { sessionId: "sess-999" } },
    };
    writeFileSync(lineageFile, JSON.stringify(record), "utf8");

    const all = listLineages(testRoot);
    const found = all.find((l) => l.incarnation.remote !== null);
    expect(found).toBeDefined();
    expect(found?.incarnation.remote?.sessionId).toBe("sess-999");
  });
});
