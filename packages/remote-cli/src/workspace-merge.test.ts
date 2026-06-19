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

import { mergeWorkspaceArchive } from "./workspace-merge.js";

// Scratch dir under the package, never /tmp (project policy)
const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "workspace-merge",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

const tmps: string[] = [];
function tdir(): string {
  const d = mkdtempSync(join(SCRATCH_ROOT, "merge-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tgz(files: Record<string, string | Buffer>): Buffer {
  const dir = tdir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const res = spawnSync("tar", ["-czf", "-", "-C", dir, "."], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return res.stdout;
}

function cwdWith(files: Record<string, string | Buffer>): string {
  const dir = tdir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("mergeWorkspaceArchive", () => {
  it("takes a remote-only new file and keeps a local-only file", () => {
    const cwd = cwdWith({ "local.txt": "mine" });
    const remote = tgz({ "remote.txt": "theirs" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: null,
    });
    expect(readFileSync(join(cwd, "remote.txt"), "utf8")).toBe("theirs");
    expect(readFileSync(join(cwd, "local.txt"), "utf8")).toBe("mine");
    expect(result.tookRemote).toContain("remote.txt");
    expect(result.conflicts).toHaveLength(0);
  });

  it("takes remote when only remote changed from base", () => {
    const base = tgz({ "a.txt": "v1\n" });
    const cwd = cwdWith({ "a.txt": "v1\n" }); // local unchanged
    const remote = tgz({ "a.txt": "v2\n" }); // remote changed
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("v2\n");
    expect(result.tookRemote).toContain("a.txt");
  });

  it("keeps local when only local changed from base", () => {
    const base = tgz({ "a.txt": "v1\n" });
    const cwd = cwdWith({ "a.txt": "local-change\n" });
    const remote = tgz({ "a.txt": "v1\n" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("local-change\n");
    expect(result.keptLocal).toContain("a.txt");
  });

  it("auto-merges non-overlapping changes on both sides", () => {
    const base = tgz({ "a.txt": "line1\nline2\nline3\n" });
    const cwd = cwdWith({ "a.txt": "LINE1\nline2\nline3\n" }); // local edits line1
    const remote = tgz({ "a.txt": "line1\nline2\nLINE3\n" }); // remote edits line3
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    expect(result.conflicts).toHaveLength(0);
    const merged = readFileSync(join(cwd, "a.txt"), "utf8");
    expect(merged).toContain("LINE1");
    expect(merged).toContain("LINE3");
  });

  it("flags a conflict when both sides change the same lines", () => {
    const base = tgz({ "a.txt": "shared\n" });
    const cwd = cwdWith({ "a.txt": "local\n" });
    const remote = tgz({ "a.txt": "remote\n" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    expect(result.conflicts).toContain("a.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("binary conflict: backs up local and takes remote without calling git merge-file", () => {
    const localBin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // PNG-like with NUL
    const remoteBin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]); // different binary
    const cwd = cwdWith({ "img.png": localBin });
    const remote = tgz({ "img.png": remoteBin });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: null,
    });
    expect(result.conflicts).toContain("img.png");
    // local file should be overwritten with remote content
    expect(readFileSync(join(cwd, "img.png"))).toEqual(remoteBin);
    // a .bak file must exist
    const files = readdirSync(cwd);
    expect(files.some((f) => f.startsWith("img.png.bak-"))).toBe(true);
    // no conflict markers (it's binary, not text)
    expect(readFileSync(join(cwd, "img.png")).toString()).not.toContain("<<<<<<<");
  });

  it("binary conflict: local binary vs remote text still routes to .bak path", () => {
    const localBin = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const cwd = cwdWith({ "mixed.bin": localBin });
    const remote = tgz({ "mixed.bin": "text content\n" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: null,
    });
    expect(result.conflicts).toContain("mixed.bin");
    const files = readdirSync(cwd);
    expect(files.some((f) => f.startsWith("mixed.bin.bak-"))).toBe(true);
  });

  it("remote deleted a file: keeps the local version (no clobber)", () => {
    const base = tgz({ "kept.txt": "original\n" });
    const cwd = cwdWith({ "kept.txt": "original\n" });
    // remote archive has NO kept.txt (remote deleted it)
    const remote = tgz({ "other.txt": "unrelated\n" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    // Local file must still be present
    expect(readFileSync(join(cwd, "kept.txt"), "utf8")).toBe("original\n");
    expect(result.keptLocal).toContain("kept.txt");
    expect(result.conflicts).toHaveLength(0);
  });

  it("identical content on both sides: no-op, no conflict", () => {
    const base = tgz({ "same.txt": "unchanged\n" });
    const cwd = cwdWith({ "same.txt": "unchanged\n" });
    const remote = tgz({ "same.txt": "unchanged\n" });
    const result = mergeWorkspaceArchive({
      cwd,
      remoteArchive: remote,
      baseArchive: base,
    });
    expect(readFileSync(join(cwd, "same.txt"), "utf8")).toBe("unchanged\n");
    expect(result.conflicts).toHaveLength(0);
    expect(result.tookRemote).toHaveLength(0);
    expect(result.keptLocal).toHaveLength(0);
    expect(result.merged).toHaveLength(0);
  });
});
