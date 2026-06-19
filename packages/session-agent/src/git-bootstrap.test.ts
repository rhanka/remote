/**
 * git-bootstrap.test.ts
 *
 * Tests for the early-exit guard paths of bootstrapGit(). The network/git
 * fetch paths require a real GitHub repo and are not covered here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapGit } from "./git-bootstrap.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "git-bootstrap",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(SCRATCH_ROOT, "ws-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("bootstrapGit", () => {
  it("returns undefined when .git already exists (idempotent)", () => {
    // Simulate a workspace that already has a git repo (even a fake one)
    writeFileSync(join(ws, ".git"), "gitdir: /nonexistent\n");
    expect(bootstrapGit(ws)).toBeUndefined();
  });

  it("returns undefined when .remote/git.json does not exist", () => {
    expect(bootstrapGit(ws)).toBeUndefined();
  });

  it("returns undefined when .remote/git.json is malformed JSON", () => {
    mkdirSync(join(ws, ".remote"), { recursive: true });
    writeFileSync(join(ws, ".remote", "git.json"), "not json {{");
    expect(bootstrapGit(ws)).toBeUndefined();
  });

  it("returns undefined when .remote/git.json has no origin field", () => {
    mkdirSync(join(ws, ".remote"), { recursive: true });
    writeFileSync(
      join(ws, ".remote", "git.json"),
      JSON.stringify({ branch: "main", head: "abc123" }),
    );
    expect(bootstrapGit(ws)).toBeUndefined();
  });

  it("returns undefined when .remote/git.json has empty origin string", () => {
    mkdirSync(join(ws, ".remote"), { recursive: true });
    writeFileSync(
      join(ws, ".remote", "git.json"),
      JSON.stringify({ origin: "", branch: "main" }),
    );
    expect(bootstrapGit(ws)).toBeUndefined();
  });
});
