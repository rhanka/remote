/**
 * convsync.ts tests — Phase B1
 * Covers: encodeCwd, alignment (pure logic), localConvStat (fs-based).
 * Scratch: packages/remote-cli/.test-scratch/convsync/
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  alignment,
  encodeCwd,
  localConvStat,
  type ConvStat,
} from "./convsync.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "convsync",
);
beforeAll(() => { mkdirSync(SCRATCH_ROOT, { recursive: true }); });

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(SCRATCH_ROOT, "home-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// encodeCwd
// ---------------------------------------------------------------------------

describe("encodeCwd", () => {
  it("replaces forward slashes with dashes", () => {
    expect(encodeCwd("/home/user/project")).toBe("-home-user-project");
  });

  it("empty string returns empty string", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("no slashes — unchanged", () => {
    expect(encodeCwd("project")).toBe("project");
  });

  it("trailing slash becomes trailing dash", () => {
    expect(encodeCwd("/foo/bar/")).toBe("-foo-bar-");
  });
});

// ---------------------------------------------------------------------------
// alignment (pure logic)
// ---------------------------------------------------------------------------

function stat(
  convId: string,
  bytes: number,
  lines: number,
  sha = "abc123",
): ConvStat {
  return { convId, bytes, lines, sha };
}

describe("alignment", () => {
  it("missing: both undefined", () => {
    expect(alignment(undefined, undefined).state).toBe("missing");
  });

  it("missing: remote absent but local present", () => {
    expect(alignment(stat("a", 100, 5), undefined).state).toBe("missing");
  });

  it("remote-ahead: local absent but remote present", () => {
    expect(alignment(undefined, stat("a", 100, 5)).state).toBe("remote-ahead");
  });

  it("in-sync: same sha", () => {
    const s = stat("a", 100, 5, "same");
    expect(alignment(s, s).state).toBe("in-sync");
  });

  it("diverged: different convId", () => {
    expect(
      alignment(stat("local-id", 100, 5), stat("remote-id", 100, 5)).state,
    ).toBe("diverged");
  });

  it("local-ahead: same convId, local has more bytes", () => {
    expect(
      alignment(stat("a", 200, 10, "x"), stat("a", 100, 5, "y")).state,
    ).toBe("local-ahead");
  });

  it("remote-ahead: same convId, remote has more bytes", () => {
    expect(
      alignment(stat("a", 100, 5, "x"), stat("a", 200, 10, "y")).state,
    ).toBe("remote-ahead");
  });

  it("diverged: same convId, same bytes, different sha", () => {
    expect(
      alignment(stat("a", 100, 5, "sha1"), stat("a", 100, 5, "sha2")).state,
    ).toBe("diverged");
  });
});

// ---------------------------------------------------------------------------
// localConvStat (filesystem-based)
// ---------------------------------------------------------------------------

describe("localConvStat", () => {
  const cwd = "/home/user/my-project";
  const encoded = "-home-user-my-project";

  it("returns undefined when project dir does not exist", () => {
    expect(localConvStat(cwd, scratch)).toBeUndefined();
  });

  it("returns undefined when project dir is empty", () => {
    mkdirSync(join(scratch, ".claude", "projects", encoded), { recursive: true });
    expect(localConvStat(cwd, scratch)).toBeUndefined();
  });

  it("returns undefined when dir has no .jsonl files", () => {
    const dir = join(scratch, ".claude", "projects", encoded);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.txt"), "ignored");
    expect(localConvStat(cwd, scratch)).toBeUndefined();
  });

  it("returns stat for a single .jsonl file", () => {
    const dir = join(scratch, ".claude", "projects", encoded);
    mkdirSync(dir, { recursive: true });
    const content = '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n';
    writeFileSync(join(dir, "conv-abc.jsonl"), content);

    const result = localConvStat(cwd, scratch);
    expect(result).not.toBeUndefined();
    expect(result!.convId).toBe("conv-abc");
    expect(result!.bytes).toBe(Buffer.byteLength(content));
    expect(result!.lines).toBe(2);
    expect(result!.sha).toHaveLength(12);
  });

  it("returns the newest .jsonl when multiple exist", () => {
    const dir = join(scratch, ".claude", "projects", encoded);
    mkdirSync(dir, { recursive: true });

    const older = join(dir, "old-conv.jsonl");
    const newer = join(dir, "new-conv.jsonl");
    writeFileSync(older, "line1\n");
    writeFileSync(newer, "line1\nline2\nline3\n");

    // Ensure 'newer' has a later mtime than 'older'
    const now = Date.now() / 1000;
    utimesSync(older, now - 10, now - 10);
    utimesSync(newer, now, now);

    const result = localConvStat(cwd, scratch);
    expect(result!.convId).toBe("new-conv");
    expect(result!.lines).toBe(3);
  });
});
