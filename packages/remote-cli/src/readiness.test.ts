/**
 * readiness.test.ts — Phase A
 *
 * Tests for checkReadiness() using a mocked spawnSync.
 *
 * Scenarios:
 *  1. git ok + auth ok → ready: true, blockers: []
 *  2. no git → blocker "repo: not a git repository"
 *  3. many modified files → mode: "lazy"
 *  4. auth fails → blocker "auth: CLI not authenticated"
 *  5. git ok + auth ok + small working set → mode: "full", pending counts
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkReadiness } from "./readiness.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "readiness-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type SpawnArgs = [string, readonly string[], ...unknown[]];

/**
 * Build a fake spawnSync that dispatches based on command + first arg.
 * Returns an object with { status, stdout, stderr }.
 */
function makeSpawn(responses: {
  auth?: { status: number };
  gitRevParse?: { status: number };
  gitDiff?: { status: number; stdout: string };
  gitLsFiles?: { status: number; stdout: string };
}): typeof import("node:child_process").spawnSync {
  return vi.fn(
    (cmd: string, args: readonly string[]): SpawnSyncReturns<string> => {
      // auth check: remote auth status
      if (cmd === "remote" && args[0] === "auth" && args[1] === "status") {
        const r = responses.auth ?? { status: 0 };
        return {
          pid: 1,
          output: [],
          stdout: "",
          stderr: "",
          status: r.status,
          signal: null,
          // error omitted (exactOptionalPropertyTypes)
        };
      }
      // git rev-parse HEAD
      if (
        cmd === "git" &&
        args[0] === "rev-parse" &&
        args[1] === "HEAD"
      ) {
        const r = responses.gitRevParse ?? { status: 0 };
        return {
          pid: 1,
          output: [],
          stdout: "abc123\n",
          stderr: "",
          status: r.status,
          signal: null,
          // error omitted (exactOptionalPropertyTypes)
        };
      }
      // git diff --name-only HEAD --
      if (
        cmd === "git" &&
        args[0] === "diff" &&
        args[1] === "--name-only"
      ) {
        const r = responses.gitDiff ?? { status: 0, stdout: "" };
        return {
          pid: 1,
          output: [],
          stdout: r.stdout,
          stderr: "",
          status: r.status,
          signal: null,
          // error omitted (exactOptionalPropertyTypes)
        };
      }
      // git ls-files --others --exclude-standard
      if (
        cmd === "git" &&
        args[0] === "ls-files" &&
        args[1] === "--others"
      ) {
        const r = responses.gitLsFiles ?? { status: 0, stdout: "" };
        return {
          pid: 1,
          output: [],
          stdout: r.stdout,
          stderr: "",
          status: r.status,
          signal: null,
          // error omitted (exactOptionalPropertyTypes)
        };
      }
      return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
        // error omitted (exactOptionalPropertyTypes)
      };
    },
  ) as unknown as typeof import("node:child_process").spawnSync;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkReadiness", () => {
  it("returns ready:true and no blockers when git ok + auth ok", () => {
    const spawn = makeSpawn({
      auth: { status: 0 },
      gitRevParse: { status: 0 },
      gitDiff: { status: 0, stdout: "" },
      gitLsFiles: { status: 0, stdout: "" },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.mode).toBe("full");
    expect(result.pending.files).toBe(0);
    expect(result.pending.bytes).toBe(0);
    expect(result.pending.est_seconds).toBe(0);
  });

  it('returns blocker "repo: not a git repository" when git fails', () => {
    const spawn = makeSpawn({
      auth: { status: 0 },
      gitRevParse: { status: 128 },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("repo: not a git repository");
  });

  it('returns blocker "auth: CLI not authenticated" when auth fails', () => {
    const spawn = makeSpawn({
      auth: { status: 1 },
      gitRevParse: { status: 0 },
      gitDiff: { status: 0, stdout: "" },
      gitLsFiles: { status: 0, stdout: "" },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("auth: CLI not authenticated");
  });

  it('returns mode:"lazy" when many modified files exceed threshold', () => {
    // Generate 201 fake file names (above LAZY_FILES_THRESHOLD=200)
    const manyFiles = Array.from(
      { length: 201 },
      (_, i) => `file${i}.txt`,
    ).join("\n");

    const spawn = makeSpawn({
      auth: { status: 0 },
      gitRevParse: { status: 0 },
      gitDiff: { status: 0, stdout: manyFiles },
      gitLsFiles: { status: 0, stdout: "" },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.mode).toBe("lazy");
    // ready is true despite lazy mode (lazy is not a blocker)
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.pending.files).toBe(201);
  });

  it('returns mode:"lazy" when total bytes exceed threshold (50MB)', () => {
    // Create a real file > 50 MB in the testRoot to trigger byte threshold
    const bigFilePath = join(testRoot, "big.bin");
    // Write 51 MB of data
    const chunk = Buffer.alloc(51 * 1024 * 1024, 0x42);
    writeFileSync(bigFilePath, chunk);

    const spawn = makeSpawn({
      auth: { status: 0 },
      gitRevParse: { status: 0 },
      gitDiff: { status: 0, stdout: "" },
      gitLsFiles: { status: 0, stdout: "big.bin\n" },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.mode).toBe("lazy");
    expect(result.pending.files).toBe(1);
    expect(result.pending.bytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(result.pending.est_seconds).toBeGreaterThanOrEqual(1);
  });

  it("counts pending files from both diff and untracked, deduplicates", () => {
    // file-a.ts appears in both diff output and ls-files output
    const spawn = makeSpawn({
      auth: { status: 0 },
      gitRevParse: { status: 0 },
      gitDiff: { status: 0, stdout: "file-a.ts\nfile-b.ts\n" },
      gitLsFiles: { status: 0, stdout: "file-a.ts\nfile-c.ts\n" },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    // file-a.ts is deduplicated → 3 unique files
    expect(result.pending.files).toBe(3);
    expect(result.ready).toBe(true);
  });

  it("returns all blockers when both auth and git fail", () => {
    const spawn = makeSpawn({
      auth: { status: 1 },
      gitRevParse: { status: 128 },
    });

    const result = checkReadiness({ cwd: testRoot, spawnImpl: spawn });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("auth: CLI not authenticated");
    expect(result.blockers).toContain("repo: not a git repository");
    expect(result.blockers).toHaveLength(2);
  });

  it("never throws even if spawnImpl throws", () => {
    const throwingSpawn = vi.fn(
      (): SpawnSyncReturns<string> => {
        throw new Error("spawn failed");
      },
    ) as unknown as typeof import("node:child_process").spawnSync;

    expect(() =>
      checkReadiness({ cwd: testRoot, spawnImpl: throwingSpawn }),
    ).not.toThrow();

    const result = checkReadiness({ cwd: testRoot, spawnImpl: throwingSpawn });
    expect(result.ready).toBe(false);
    // Both auth and git will fail (throw caught)
    expect(result.blockers.length).toBeGreaterThan(0);
  });
});
