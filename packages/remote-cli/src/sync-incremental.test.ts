/**
 * Phase B1 — incremental conv sync tests.
 * Covers: readConvSyncState, writeConvSyncState (round-trip),
 * sha256Bytes (via helper), and syncConversation push incremental paths.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — evaluated BEFORE any vi.mock factory runs.
// ---------------------------------------------------------------------------
const { mockSpawnSync, mockGetTunnel, mockLocalConvStat, mockRemoteConvStat, mockHomedir, TEST_HOME, REAL_TMPDIR } =
  vi.hoisted(() => {
    // We need tmpdir() from the REAL os module before any mock takes effect.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realTmpdir: string = require("os").tmpdir() as string;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mkdtempSyncReal = require("fs").mkdtempSync as (prefix: string) => string;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathJoin = require("path").join as (...args: string[]) => string;
    const TEST_HOME = mkdtempSyncReal(pathJoin(realTmpdir, "sync-b1-test-"));
    return {
      mockSpawnSync: vi.fn(),
      mockGetTunnel: vi.fn(),
      mockLocalConvStat: vi.fn(),
      mockRemoteConvStat: vi.fn(),
      mockHomedir: vi.fn(() => TEST_HOME),
      TEST_HOME,
      REAL_TMPDIR: realTmpdir,
    };
  });

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
  tmpdir: () => REAL_TMPDIR,
}));

vi.mock("./config.js", () => ({
  getTunnel: mockGetTunnel,
}));

vi.mock("./convsync.js", () => ({
  encodeCwd: (cwd: string) => cwd.replace(/\//g, "-"),
  localConvStat: mockLocalConvStat,
  remoteConvStat: mockRemoteConvStat,
}));

// Import after mocks are registered.
import {
  readConvSyncState,
  syncConversation,
  writeConvSyncState,
} from "./sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const FAKE_TUNNEL = { namespace: "test-ns", kubeconfig: undefined };

// ---------------------------------------------------------------------------
// 1. readConvSyncState returns undefined for a missing file
// ---------------------------------------------------------------------------

describe("readConvSyncState", () => {
  it("returns undefined when the state file does not exist", () => {
    const result = readConvSyncState("nonexistent-conv-xyzzy");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the file contains invalid JSON", () => {
    const p = join(TEST_HOME, ".remote", "conv-sync-state", "bad-json.json");
    mkdirSync(join(TEST_HOME, ".remote", "conv-sync-state"), {
      recursive: true,
    });
    writeFileSync(p, "not-json");
    const result = readConvSyncState("bad-json");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. writeConvSyncState / readConvSyncState round-trip (atomic write)
// ---------------------------------------------------------------------------

describe("writeConvSyncState / readConvSyncState round-trip", () => {
  it("writes and reads back the state atomically", () => {
    const convId = "conv-roundtrip-1";
    const state = {
      offset: 1024,
      prefixHash: "a".repeat(64),
      generation: 3,
      updatedAt: "2026-06-19T00:00:00.000Z",
    };
    writeConvSyncState(state, convId);
    const read = readConvSyncState(convId);
    expect(read).toEqual(state);
  });

  it("overwrites a previous state, latest generation wins", () => {
    const convId = "conv-overwrite-2";
    writeConvSyncState(
      {
        offset: 100,
        prefixHash: "b".repeat(64),
        generation: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      convId,
    );
    writeConvSyncState(
      {
        offset: 200,
        prefixHash: "c".repeat(64),
        generation: 2,
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      convId,
    );
    const read = readConvSyncState(convId);
    expect(read?.offset).toBe(200);
    expect(read?.generation).toBe(2);
  });

  it("preserves optional lastAckedToken when present", () => {
    const convId = "conv-token-3";
    const state = {
      offset: 512,
      prefixHash: "d".repeat(64),
      generation: 0,
      lastAckedToken: 42,
      updatedAt: "2026-06-19T00:00:00.000Z",
    };
    writeConvSyncState(state, convId);
    const read = readConvSyncState(convId);
    expect(read?.lastAckedToken).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 3. sha256Bytes produces a 64-char hex string (tested via sha256hex helper)
// ---------------------------------------------------------------------------

describe("sha256Bytes (verified through sha256hex helper)", () => {
  it("returns a 64-character lowercase hex string", () => {
    const hex = sha256hex(Buffer.from("hello world"));
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", () => {
    expect(sha256hex(Buffer.from("aaa"))).not.toBe(sha256hex(Buffer.from("bbb")));
  });

  it("prefixHash stored in state equals sha256 of the prefix buffer", () => {
    const convId = "conv-sha-check";
    const buf = Buffer.from("test content for hash check");
    const expectedHash = sha256hex(buf);
    writeConvSyncState(
      {
        offset: buf.length,
        prefixHash: expectedHash,
        generation: 1,
        updatedAt: "2026-06-19T00:00:00.000Z",
      },
      convId,
    );
    const read = readConvSyncState(convId);
    expect(read?.prefixHash).toBe(expectedHash);
    expect(read?.prefixHash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// 4. syncConversation push incremental: mock execPodRaw rc=0 → {ok:true, incremental:true}
// ---------------------------------------------------------------------------

describe("syncConversation push — incremental path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTunnel.mockReturnValue(FAKE_TUNNEL);
    mockHomedir.mockReturnValue(TEST_HOME);
  });

  it("returns {ok:true, incremental:true} when pod prefix matches and append succeeds", () => {
    // Existing local conv content: prefix (10 bytes) + delta (5 bytes)
    const prefix = Buffer.from("AAAAAAAAAA"); // 10 bytes
    const delta = Buffer.from("BBBBB"); // 5 bytes
    const fullContent = Buffer.concat([prefix, delta]);
    const prefixHash = sha256hex(prefix);

    const workspacePath = "/workspace/inc-push";
    const convId = "conv-inc-push-1";
    const localDir = join(
      TEST_HOME,
      ".claude",
      "projects",
      "-workspace-inc-push",
    );
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, `${convId}.jsonl`), fullContent);

    // Write existing sync state (prefix already synced)
    writeConvSyncState(
      {
        offset: prefix.length,
        prefixHash,
        generation: 1,
        updatedAt: "2026-06-19T00:00:00.000Z",
      },
      convId,
    );

    mockLocalConvStat.mockReturnValue({
      convId,
      bytes: fullContent.length,
      lines: 2,
      sha: sha256hex(fullContent).slice(0, 12),
    });

    // spawnSync calls:
    // 1. probe (check if remote file exists + line count) → yes, 2 lines
    // 2. incremental append (execPodRaw) → rc=0
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "yes\t2", stderr: "" }) // probe
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // incremental append

    const result = syncConversation({
      sessionId: "sess-inc-1",
      workspacePath,
      direction: "push",
      force: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.incremental).toBe(true);
      expect(result.backup).toBeUndefined();
      expect(result.convId).toBe(convId);
      expect(result.direction).toBe("push");
    }

    // State should be updated with new offset = full content length
    const newState = readConvSyncState(convId);
    expect(newState?.offset).toBe(fullContent.length);
    expect(newState?.generation).toBe(2);
    expect(newState?.prefixHash).toBe(sha256hex(fullContent));
  });
});

// ---------------------------------------------------------------------------
// 5. syncConversation push mismatch (rc=42) → fallback whole-file
// ---------------------------------------------------------------------------

describe("syncConversation push — pod prefix mismatch fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTunnel.mockReturnValue(FAKE_TUNNEL);
    mockHomedir.mockReturnValue(TEST_HOME);
  });

  it("falls back to whole-file when pod returns rc=42 (prefix mismatch)", () => {
    const prefix = Buffer.from("CCCCCCCCCC");
    const delta = Buffer.from("DDDDD");
    const fullContent = Buffer.concat([prefix, delta]);
    const prefixHash = sha256hex(prefix);

    const workspacePath = "/workspace/inc-mismatch";
    const convId = "conv-inc-mismatch-1";
    const localDir = join(
      TEST_HOME,
      ".claude",
      "projects",
      "-workspace-inc-mismatch",
    );
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, `${convId}.jsonl`), fullContent);

    writeConvSyncState(
      {
        offset: prefix.length,
        prefixHash,
        generation: 1,
        updatedAt: "2026-06-19T00:00:00.000Z",
      },
      convId,
    );

    mockLocalConvStat.mockReturnValue({
      convId,
      bytes: fullContent.length,
      lines: 2,
      sha: sha256hex(fullContent).slice(0, 12),
    });

    // spawnSync calls:
    // 1. probe → remote exists, 1 line
    // 2. incremental append → rc=42 (mismatch on pod side)
    // 3. whole-file base64 -d → rc=0
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "yes\t1", stderr: "" }) // probe
      .mockReturnValueOnce({ status: 42, stdout: "", stderr: "" }) // incremental → mismatch
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // whole-file push

    const result = syncConversation({
      sessionId: "sess-mm-1",
      workspacePath,
      direction: "push",
      force: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.incremental).toBe(false);
      // Remote existed → backup was taken
      expect(result.backup).toBeDefined();
    }

    // State updated after whole-file sync
    const newState = readConvSyncState(convId);
    expect(newState?.offset).toBe(fullContent.length);
    expect(newState?.generation).toBe(2); // 1 + 1
  });
});

// ---------------------------------------------------------------------------
// 6. No sync state → whole-file (incremental: false)
// ---------------------------------------------------------------------------

describe("syncConversation push — no state → whole-file only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTunnel.mockReturnValue(FAKE_TUNNEL);
    mockHomedir.mockReturnValue(TEST_HOME);
  });

  it("uses whole-file path (incremental:false) when no sync state exists", () => {
    const content = Buffer.from("HELLO WORLD CONVERSATION\n");
    const workspacePath = "/workspace/inc-nostate";
    const convId = "conv-nostate-1";
    const localDir = join(
      TEST_HOME,
      ".claude",
      "projects",
      "-workspace-inc-nostate",
    );
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, `${convId}.jsonl`), content);

    // No sync state written → readConvSyncState returns undefined

    mockLocalConvStat.mockReturnValue({
      convId,
      bytes: content.length,
      lines: 1,
      sha: sha256hex(content).slice(0, 12),
    });

    // spawnSync calls:
    // 1. probe → remote does not exist
    // 2. whole-file base64 -d → rc=0
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "no\t0", stderr: "" }) // probe
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // whole-file push

    const result = syncConversation({
      sessionId: "sess-ns-1",
      workspacePath,
      direction: "push",
      force: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.incremental).toBe(false);
      expect(result.backup).toBeUndefined(); // remote did not exist
    }

    // State should now be recorded for the first time
    const newState = readConvSyncState(convId);
    expect(newState).toBeDefined();
    expect(newState?.offset).toBe(content.length);
    expect(newState?.generation).toBe(1); // 0 + 1
    expect(newState?.prefixHash).toBe(sha256hex(content));
  });
});
