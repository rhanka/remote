/**
 * Phase B3 — sync-status tests.
 * Scratch dir: packages/remote-cli/.test-scratch/sync-status/
 * Never uses /tmp.
 * Isolation: sets HOME to a temp dir so ~/.remote/sync-status writes go there.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// We import the functions under test AFTER setting up HOME so homedir() resolves
// to the scratch location. With ESM static imports, the module caches the
// homedir() call at call-time (not at load-time), so patching HOME before each
// call is sufficient.
import {
  emptyMetrics,
  mergedState,
  readSyncStatus,
  syncStatusPath,
  writeSyncStatus,
  type ClassMetrics,
  type SyncStatus,
} from "./sync-status.js";

// ---------------------------------------------------------------------------
// Scratch dir & HOME isolation
// ---------------------------------------------------------------------------

const SCRATCH_BASE = join(
  process.cwd(),
  "packages/remote-cli/.test-scratch/sync-status",
);

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  tmpHome = mkdtempSync(join(SCRATCH_BASE, "home-"));
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

beforeEach(() => {
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
});

// ---------------------------------------------------------------------------
// emptyMetrics
// ---------------------------------------------------------------------------

describe("emptyMetrics", () => {
  it("returns zero-valued metrics with null lastAckedAt", () => {
    const m = emptyMetrics();
    expect(m.pendingBytes).toBe(0);
    expect(m.pendingCount).toBe(0);
    expect(m.oldestPendingAge).toBe(0);
    expect(m.lastAckedAt).toBeNull();
    expect(m.estimatedCatchup).toBe(0);
  });

  it("is a fresh object on each call", () => {
    const a = emptyMetrics();
    const b = emptyMetrics();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// mergedState
// ---------------------------------------------------------------------------

describe("mergedState", () => {
  it("returns synced when all classes are synced", () => {
    expect(mergedState(["synced", "synced", "synced"])).toBe("synced");
  });

  it("returns pending when one class is pending and none blocked/degraded", () => {
    expect(mergedState(["synced", "pending", "synced"])).toBe("pending");
  });

  it("degraded beats pending", () => {
    expect(mergedState(["pending", "degraded", "synced"])).toBe("degraded");
  });

  it("blocked beats all", () => {
    expect(mergedState(["pending", "degraded", "blocked"])).toBe("blocked");
  });

  it("returns synced for empty array", () => {
    expect(mergedState([])).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// readSyncStatus / writeSyncStatus round-trip
// ---------------------------------------------------------------------------

describe("readSyncStatus / writeSyncStatus", () => {
  it("returns null for an unknown sessionId", () => {
    expect(readSyncStatus("unknown-session-xyz")).toBeNull();
  });

  it("round-trips a SyncStatus object", () => {
    const sessionId = "test-session-roundtrip";
    const m: ClassMetrics = {
      pendingBytes: 1024,
      pendingCount: 3,
      oldestPendingAge: 18,
      lastAckedAt: "2026-06-19T00:00:00.000Z",
      estimatedCatchup: 4,
    };
    const status: SyncStatus = {
      state: "pending",
      safeToClose: false,
      updatedAt: "2026-06-19T00:00:00.000Z",
      conv: emptyMetrics(),
      hot: m,
      cold: emptyMetrics(),
    };

    writeSyncStatus(sessionId, status);
    const read = readSyncStatus(sessionId);
    expect(read).not.toBeNull();
    expect(read!.state).toBe("pending");
    expect(read!.safeToClose).toBe(false);
    expect(read!.hot.pendingBytes).toBe(1024);
    expect(read!.hot.pendingCount).toBe(3);
    expect(read!.hot.lastAckedAt).toBe("2026-06-19T00:00:00.000Z");
    expect(read!.conv.pendingBytes).toBe(0);
  });

  it("syncStatusPath contains sync-status dir and session filename", () => {
    const p = syncStatusPath("my-session");
    expect(p).toContain("sync-status");
    expect(p).toContain("my-session.json");
  });

  it("overwrites an existing status with the new value", () => {
    const sessionId = "test-session-overwrite";
    const first: SyncStatus = {
      state: "pending",
      safeToClose: false,
      updatedAt: "2026-06-19T00:00:01.000Z",
      conv: emptyMetrics(),
      hot: emptyMetrics(),
      cold: emptyMetrics(),
    };
    const second: SyncStatus = {
      state: "synced",
      safeToClose: true,
      updatedAt: "2026-06-19T00:00:02.000Z",
      conv: emptyMetrics(),
      hot: emptyMetrics(),
      cold: emptyMetrics(),
    };
    writeSyncStatus(sessionId, first);
    writeSyncStatus(sessionId, second);
    const read = readSyncStatus(sessionId);
    expect(read!.state).toBe("synced");
    expect(read!.safeToClose).toBe(true);
  });

  it("handles a blocked state with non-zero metrics", () => {
    const sessionId = "test-session-blocked";
    const status: SyncStatus = {
      state: "blocked",
      safeToClose: false,
      updatedAt: "2026-06-19T01:00:00.000Z",
      conv: { pendingBytes: 512, pendingCount: 1, oldestPendingAge: 120, lastAckedAt: null, estimatedCatchup: 30 },
      hot: emptyMetrics(),
      cold: emptyMetrics(),
    };
    writeSyncStatus(sessionId, status);
    const read = readSyncStatus(sessionId);
    expect(read!.state).toBe("blocked");
    expect(read!.conv.pendingBytes).toBe(512);
    expect(read!.conv.oldestPendingAge).toBe(120);
  });
});
