/**
 * migrate-candidates.ts tests
 * Covers: humanSize, humanAge (pure), listMigrationCandidates (fs-based).
 * Scratch: packages/remote-cli/.test-scratch/migrate-candidates/
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
  humanAge,
  humanSize,
  listMigrationCandidates,
} from "./migrate-candidates.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "migrate-candidates",
);
beforeAll(() => { mkdirSync(SCRATCH_ROOT, { recursive: true }); });

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(SCRATCH_ROOT, "home-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// humanSize
// ---------------------------------------------------------------------------

describe("humanSize", () => {
  it("small values are in K", () => {
    expect(humanSize(1024)).toBe("1K");
    expect(humanSize(256)).toBe("0K"); // 0.25 → rounds to 0
    expect(humanSize(2048)).toBe("2K");
  });

  it("values >= 1 MiB are in M", () => {
    expect(humanSize(1024 * 1024)).toBe("1.0M");
    expect(humanSize(1.5 * 1024 * 1024)).toBe("1.5M");
  });

  it("zero is 0K", () => {
    expect(humanSize(0)).toBe("0K");
  });
});

// ---------------------------------------------------------------------------
// humanAge
// ---------------------------------------------------------------------------

describe("humanAge", () => {
  const now = 1_700_000_000_000;

  it("seconds when < 90s", () => {
    expect(humanAge(now - 30_000, now)).toBe("30s");
    expect(humanAge(now - 89_000, now)).toBe("89s");
  });

  it("minutes when >= 90s and < 90m", () => {
    expect(humanAge(now - 2 * 60_000, now)).toBe("2m");
    expect(humanAge(now - 89 * 60_000, now)).toBe("89m");
  });

  it("hours when >= 90m and < 36h", () => {
    expect(humanAge(now - 2 * 3600_000, now)).toBe("2h");
    expect(humanAge(now - 35 * 3600_000, now)).toBe("35h");
  });

  it("days when >= 36h", () => {
    expect(humanAge(now - 48 * 3600_000, now)).toBe("2d");
    expect(humanAge(now - 72 * 3600_000, now)).toBe("3d");
  });

  it("0s for now and future", () => {
    expect(humanAge(now, now)).toBe("0s");
    expect(humanAge(now + 1000, now)).toBe("0s");
  });
});

// ---------------------------------------------------------------------------
// listMigrationCandidates (filesystem-based)
// ---------------------------------------------------------------------------

describe("listMigrationCandidates", () => {
  function makeProjectDir(encodedDir: string): string {
    const dir = join(scratch, ".claude", "projects", encodedDir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("returns empty array when ~/.claude/projects does not exist", () => {
    expect(listMigrationCandidates(scratch)).toEqual([]);
  });

  it("ignores project dirs with no .jsonl files", () => {
    const dir = makeProjectDir("-home-user-empty");
    writeFileSync(join(dir, "other.txt"), "ignored");
    expect(listMigrationCandidates(scratch)).toHaveLength(0);
  });

  it("returns one candidate per project dir with .jsonl files", () => {
    const dir = makeProjectDir("-home-user-project");
    writeFileSync(join(dir, "conv1.jsonl"), "line1\n");
    const candidates = listMigrationCandidates(scratch);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.encodedDir).toBe("-home-user-project");
    expect(candidates[0]!.convCount).toBe(1);
  });

  it("sums bytes across multiple .jsonl files", () => {
    const dir = makeProjectDir("-home-user-multi");
    writeFileSync(join(dir, "a.jsonl"), "aaa\n");
    writeFileSync(join(dir, "b.jsonl"), "bb\n");
    const candidates = listMigrationCandidates(scratch);
    expect(candidates[0]!.sizeBytes).toBe(4 + 3); // "aaa\n" = 4, "bb\n" = 3
    expect(candidates[0]!.convCount).toBe(2);
  });

  it("sorts candidates by lastActivity descending (most recent first)", () => {
    const now = Date.now() / 1000;
    const older = makeProjectDir("-home-user-older");
    const newer = makeProjectDir("-home-user-newer");
    writeFileSync(join(older, "c.jsonl"), "x\n");
    writeFileSync(join(newer, "c.jsonl"), "x\n");
    utimesSync(join(older, "c.jsonl"), now - 100, now - 100);
    utimesSync(join(newer, "c.jsonl"), now, now);

    const candidates = listMigrationCandidates(scratch);
    expect(candidates[0]!.encodedDir).toBe("-home-user-newer");
    expect(candidates[1]!.encodedDir).toBe("-home-user-older");
  });

  it("falls back to decodePath when .jsonl has no cwd field", () => {
    const dir = makeProjectDir("-home-user-fallback");
    writeFileSync(join(dir, "c.jsonl"), '{"role":"user"}\n');
    const candidates = listMigrationCandidates(scratch);
    // decodePath("-home-user-fallback") = "/home/user/fallback"
    expect(candidates[0]!.path).toBe("/home/user/fallback");
  });

  it("reads cwd from first .jsonl entry that has one", () => {
    const dir = makeProjectDir("-home-user-cwd");
    const line = JSON.stringify({ cwd: "/actual/project/path" }) + "\n";
    writeFileSync(join(dir, "c.jsonl"), line);
    const candidates = listMigrationCandidates(scratch);
    expect(candidates[0]!.path).toBe("/actual/project/path");
  });

  it("linked is true when .remote/workspace.json exists in the cwd", () => {
    // Create a fake workspace with the linking file
    const fakeProject = join(scratch, "the-project");
    mkdirSync(join(fakeProject, ".remote"), { recursive: true });
    writeFileSync(join(fakeProject, ".remote", "workspace.json"), "{}");

    const dir = makeProjectDir("-home-user-linked");
    const line = JSON.stringify({ cwd: fakeProject }) + "\n";
    writeFileSync(join(dir, "c.jsonl"), line);

    const candidates = listMigrationCandidates(scratch);
    expect(candidates[0]!.linked).toBe(true);
  });
});
