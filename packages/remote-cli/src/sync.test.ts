import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  decideSyncAction,
  localConvFile,
  readConvSyncState,
  remoteConvRel,
  writeConvSyncState,
} from "./sync.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "sync",
);
beforeAll(() => { mkdirSync(SCRATCH_ROOT, { recursive: true }); });

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(SCRATCH_ROOT, "home-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("decideSyncAction (ahead-guard)", () => {
  it("allows pull when remote is ahead", () => {
    expect(
      decideSyncAction({ localLines: 10, remoteLines: 25, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows pull when both sides are equal", () => {
    expect(
      decideSyncAction({ localLines: 10, remoteLines: 10, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("refuses pull when local is ahead (would lose local lines)", () => {
    const d = decideSyncAction({
      localLines: 30,
      remoteLines: 10,
      direction: "pull",
      force: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("local conversation is ahead");
      expect(d.reason).toContain("30 vs 10");
      expect(d.reason).toContain("20 local line(s)");
      expect(d.reason).toContain("--force");
    }
  });

  it("allows pull over an ahead local with --force", () => {
    expect(
      decideSyncAction({ localLines: 30, remoteLines: 10, direction: "pull", force: true }),
    ).toEqual({ allow: true });
  });

  it("allows push when local is ahead", () => {
    expect(
      decideSyncAction({ localLines: 25, remoteLines: 10, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows push when both sides are equal", () => {
    expect(
      decideSyncAction({ localLines: 7, remoteLines: 7, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });

  it("refuses push when remote is ahead (would lose remote lines)", () => {
    const d = decideSyncAction({
      localLines: 5,
      remoteLines: 12,
      direction: "push",
      force: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("remote conversation is ahead");
      expect(d.reason).toContain("12 vs 5");
      expect(d.reason).toContain("7 remote line(s)");
      expect(d.reason).toContain("--force");
    }
  });

  it("allows push over an ahead remote with --force", () => {
    expect(
      decideSyncAction({ localLines: 5, remoteLines: 12, direction: "push", force: true }),
    ).toEqual({ allow: true });
  });

  it("allows pull when there is no local conversation at all (0 lines)", () => {
    expect(
      decideSyncAction({ localLines: 0, remoteLines: 42, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows push when the remote file does not exist yet (0 lines)", () => {
    expect(
      decideSyncAction({ localLines: 42, remoteLines: 0, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });
});

describe("conversation paths (claude cwd encoding, slashes → dashes)", () => {
  it("localConvFile builds the local jsonl path under ~/.claude/projects", () => {
    expect(localConvFile("/home/dev/src/app", "abc-123", "/home/dev")).toBe(
      "/home/dev/.claude/projects/-home-dev-src-app/abc-123.jsonl",
    );
  });

  it("remoteConvRel builds the $HOME-relative Pod path with the same encoding", () => {
    expect(remoteConvRel("/data/workspaces/w1/repo", "abc-123")).toBe(
      ".claude/projects/-data-workspaces-w1-repo/abc-123.jsonl",
    );
  });

  it("local and remote use the SAME encoding for the same workspace", () => {
    const ws = "/home/dev/src/remote";
    const local = localConvFile(ws, "c1", "/home/dev");
    const rel = remoteConvRel(ws, "c1");
    expect(local.endsWith(rel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readConvSyncState / writeConvSyncState — B1 incremental state persistence
// ---------------------------------------------------------------------------

describe("readConvSyncState / writeConvSyncState", () => {
  it("returns undefined when no state file exists", () => {
    expect(readConvSyncState("conv-abc", scratch)).toBeUndefined();
  });

  it("round-trips a state record atomically", () => {
    const state = {
      offset: 1024,
      prefixHash: "abcdef012345",
      generation: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConvSyncState(state, "conv-abc", scratch);
    const result = readConvSyncState("conv-abc", scratch);
    expect(result).toEqual(state);
  });

  it("creates parent directories if missing", () => {
    writeConvSyncState(
      { offset: 0, prefixHash: "x", generation: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      "conv-fresh",
      scratch,
    );
    const statePath = join(scratch, ".remote", "conv-sync-state", "conv-fresh.json");
    expect(existsSync(statePath)).toBe(true);
  });

  it("uses atomic temp file (no leftover .tmp on success)", () => {
    writeConvSyncState(
      { offset: 512, prefixHash: "y", generation: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
      "conv-x",
      scratch,
    );
    const statePath = join(scratch, ".remote", "conv-sync-state", "conv-x.json");
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });

  it("overwrites an existing state on re-write", () => {
    const first = {
      offset: 100,
      prefixHash: "aaa",
      generation: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const second = {
      offset: 200,
      prefixHash: "bbb",
      generation: 2,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    writeConvSyncState(first, "conv-z", scratch);
    writeConvSyncState(second, "conv-z", scratch);
    expect(readConvSyncState("conv-z", scratch)).toEqual(second);
  });

  it("returns undefined for a corrupt state file", () => {
    const dir = join(scratch, ".remote", "conv-sync-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "corrupt.json"), "not json {{");
    expect(readConvSyncState("corrupt", scratch)).toBeUndefined();
  });
});
