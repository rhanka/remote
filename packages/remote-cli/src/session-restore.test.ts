import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restoreSessionsToLocal } from "./session-restore.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "session-restore",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

const tmps: string[] = [];
function tdir(): string {
  const d = mkdtempSync(join(SCRATCH_ROOT, "restore-test-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Build a workspace export archive containing .remote/sessions/<profile>/<rel>=content
function exportArchive(profile: string, files: Record<string, string>): Buffer {
  const dir = tdir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ".remote/sessions", profile, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return spawnSync("tar", ["-czf", "-", "-C", dir, "."], {
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
}

function homeWith(files: Record<string, string>): string {
  const dir = tdir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("restoreSessionsToLocal", () => {
  it("writes a new conversation when local is absent", () => {
    const archive = exportArchive("codex", { ".codex/sessions/c.jsonl": "t1\n" });
    const home = homeWith({});
    const r = restoreSessionsToLocal({ home, profile: "codex", remoteArchive: archive, onConflict: "block" });
    expect(r.restored).toContain(".codex/sessions/c.jsonl");
    expect(readFileSync(join(home, ".codex/sessions/c.jsonl"), "utf8")).toBe("t1\n");
  });

  it("overwrites when remote is a continuation of local (prefix)", () => {
    const archive = exportArchive("codex", { ".codex/sessions/c.jsonl": "t1\nt2\n" });
    const home = homeWith({ ".codex/sessions/c.jsonl": "t1\n" });
    const r = restoreSessionsToLocal({ home, profile: "codex", remoteArchive: archive, onConflict: "block" });
    expect(r.restored).toContain(".codex/sessions/c.jsonl");
    expect(readFileSync(join(home, ".codex/sessions/c.jsonl"), "utf8")).toBe("t1\nt2\n");
  });

  it("keeps local when local is ahead of remote", () => {
    const archive = exportArchive("codex", { ".codex/sessions/c.jsonl": "t1\n" });
    const home = homeWith({ ".codex/sessions/c.jsonl": "t1\nt2-local\n" });
    const r = restoreSessionsToLocal({ home, profile: "codex", remoteArchive: archive, onConflict: "block" });
    expect(r.keptLocal).toContain(".codex/sessions/c.jsonl");
    expect(readFileSync(join(home, ".codex/sessions/c.jsonl"), "utf8")).toBe("t1\nt2-local\n");
  });

  it("blocks on divergence by default", () => {
    const archive = exportArchive("codex", { ".codex/sessions/c.jsonl": "remote\n" });
    const home = homeWith({ ".codex/sessions/c.jsonl": "local\n" });
    const r = restoreSessionsToLocal({ home, profile: "codex", remoteArchive: archive, onConflict: "block" });
    expect(r.conflicts).toContain(".codex/sessions/c.jsonl");
    // untouched
    expect(readFileSync(join(home, ".codex/sessions/c.jsonl"), "utf8")).toBe("local\n");
  });

  it("backup keeps both: duplicates local under a fresh id, writes remote", () => {
    const archive = exportArchive("codex", { ".codex/sessions/abcdef12.jsonl": "remote\n" });
    const home = homeWith({ ".codex/sessions/abcdef12.jsonl": "local-abcdef12\n" });
    const r = restoreSessionsToLocal({ home, profile: "codex", remoteArchive: archive, onConflict: "backup" });
    expect(r.backedUp.length).toBe(1);
    // remote now at the original path
    expect(readFileSync(join(home, ".codex/sessions/abcdef12.jsonl"), "utf8")).toBe("remote\n");
    // a second file exists (the backup with a new id, original-id string substituted)
    const files = readdirSync(join(home, ".codex/sessions"));
    expect(files.length).toBe(2);
    const backup = files.find((f) => f !== "abcdef12.jsonl")!;
    expect(readFileSync(join(home, ".codex/sessions", backup), "utf8")).not.toContain("abcdef12");
  });
});
