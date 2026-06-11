import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceArchive } from "./workspace-sync.js";

const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "workspace-sync",
);

let scratch: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "ws-"));
  // The scratch dir lives inside this repo's work tree; a broken .git marker
  // makes git fail there so buildWorkspaceArchive takes the non-git fallback
  // (same shape as a real-world dir with a stale/empty .git).
  writeFileSync(join(scratch, ".git"), "gitdir: /nonexistent\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function write(rel: string, content = "x") {
  const abs = join(scratch, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function listArchive(archive: Buffer): string[] {
  const out = execFileSync("tar", ["-tzf", "-"], { input: archive });
  return out.toString("utf8").split("\n").filter(Boolean);
}

describe("buildWorkspaceArchive (non-git fallback)", () => {
  it("honors root .gitignore patterns but never drops .remote/.claude state", async () => {
    write(
      ".gitignore",
      "# build artifacts\nbig/\n/anchored-dir\n*.log\n.claude/\n.remote/\n",
    );
    write("src/app.ts");
    write("big/blob.bin");
    write("anchored-dir/x.txt");
    write("notes.log");
    // Migrated conversation state: nested `.claude/` path segment must survive
    // even though `.claude/` (and `.remote/`) are gitignored.
    write(".remote/sessions/claude/.claude/projects/-p/conv.jsonl");

    const names = listArchive(await buildWorkspaceArchive(scratch));

    expect(names).toContain("./src/app.ts");
    expect(names).toContain(
      "./.remote/sessions/claude/.claude/projects/-p/conv.jsonl",
    );
    expect(names.some((n) => n.includes("blob.bin"))).toBe(false);
    expect(names.some((n) => n.includes("anchored-dir"))).toBe(false);
    expect(names.some((n) => n.includes("notes.log"))).toBe(false);
  });

  it("still packs everything but .git/node_modules without a .gitignore", async () => {
    write("src/app.ts");
    write("node_modules/dep/index.js");

    const names = listArchive(await buildWorkspaceArchive(scratch));

    expect(names).toContain("./src/app.ts");
    expect(names.some((n) => n.includes("node_modules"))).toBe(false);
    expect(names.some((n) => n.includes(".git"))).toBe(false);
  });
});
