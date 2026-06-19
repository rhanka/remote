/**
 * Phase B2 — workspace-sync-incremental tests.
 * Exercises: isGitRepo, getHeadSha, sha256Buf, buildIncrementalManifest,
 * buildUntrackedTarball.
 * All tmp directories are created under the system tmpdir (resolved via the
 * real `os.tmpdir()` before any mock — no /tmp hardcoding per project policy
 * which forbids /tmp; we use mkdtempSync with the real tmpdir here since this
 * is *test* infrastructure, not workspace data).
 */

import {
  execSync,
  spawnSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildIncrementalManifest,
  buildUntrackedTarball,
  getHeadSha,
  isGitRepo,
  sha256Buf,
} from "./workspace-sync-incremental.js";

// ---------------------------------------------------------------------------
// Shared temp git repo, created once for the suite.
// ---------------------------------------------------------------------------

let tmpRepo: string;
let initialSha: string;

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), "wsync-incr-test-"));
  // Minimal git repo with one commit so HEAD resolves.
  execSync("git init -b main", { cwd: tmpRepo, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: tmpRepo,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', { cwd: tmpRepo, stdio: "pipe" });
  writeFileSync(join(tmpRepo, "hello.txt"), "hello world\n");
  execSync("git add hello.txt", { cwd: tmpRepo, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: tmpRepo, stdio: "pipe" });
  initialSha =
    spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpRepo,
      encoding: "utf8",
    }).stdout.trim();
});

afterAll(() => {
  try {
    rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// 1. isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  it("returns true for a real git repo", () => {
    // process.cwd() is the monorepo root — always a git repo.
    expect(isGitRepo(process.cwd())).toBe(true);
  });

  it("returns true for the temp repo we created", () => {
    expect(isGitRepo(tmpRepo)).toBe(true);
  });

  it("returns false for a non-git directory", () => {
    // tmpdir() itself is not a git repo (no .git at its root).
    // Create an isolated plain dir to be safe.
    const plainDir = mkdtempSync(join(tmpdir(), "not-git-"));
    try {
      expect(isGitRepo(plainDir)).toBe(false);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. getHeadSha
// ---------------------------------------------------------------------------

describe("getHeadSha", () => {
  it("returns a 40-char hex sha in the temp repo", () => {
    const sha = getHeadSha(tmpRepo);
    expect(sha).toBeDefined();
    expect(sha).toHaveLength(40);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches the sha we recorded at beforeAll", () => {
    expect(getHeadSha(tmpRepo)).toBe(initialSha);
  });

  it("returns undefined for a non-git directory", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "not-git-sha-"));
    try {
      expect(getHeadSha(plainDir)).toBeUndefined();
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. sha256Buf
// ---------------------------------------------------------------------------

describe("sha256Buf", () => {
  it("returns a 64-char lowercase hex string", () => {
    const hex = sha256Buf(Buffer.from("hello world"));
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same input gives same hash", () => {
    const buf = Buffer.from("deterministic test");
    expect(sha256Buf(buf)).toBe(sha256Buf(buf));
  });

  it("different inputs produce different hashes", () => {
    expect(sha256Buf(Buffer.from("aaa"))).not.toBe(
      sha256Buf(Buffer.from("bbb")),
    );
  });

  it("empty buffer has known sha256", () => {
    const hex = sha256Buf(Buffer.alloc(0));
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. buildIncrementalManifest
// ---------------------------------------------------------------------------

describe("buildIncrementalManifest", () => {
  it("base matches the commit sha passed in", () => {
    const manifest = buildIncrementalManifest(tmpRepo, initialSha);
    expect(manifest.base).toBe(initialSha);
  });

  it("tracked is a base64 string (may be empty if no changes since base)", () => {
    const manifest = buildIncrementalManifest(tmpRepo, initialSha);
    // No changes since initialSha → diff is empty, but base64 of empty is ""
    expect(typeof manifest.tracked).toBe("string");
    // Must be valid base64 (or empty string)
    const decoded = Buffer.from(manifest.tracked, "base64");
    expect(Buffer.from(decoded).toString("base64")).toBe(manifest.tracked);
  });

  it("tracked is non-empty when a committed change exists since baseSha", () => {
    // Create a second commit in the temp repo.
    const repoB = mkdtempSync(join(tmpdir(), "wsync-incr-b-"));
    try {
      execSync("git init -b main", { cwd: repoB, stdio: "pipe" });
      execSync('git config user.email "t@t.com"', { cwd: repoB, stdio: "pipe" });
      execSync('git config user.name "T"', { cwd: repoB, stdio: "pipe" });
      writeFileSync(join(repoB, "a.txt"), "first\n");
      execSync("git add a.txt", { cwd: repoB, stdio: "pipe" });
      execSync('git commit -m "first"', { cwd: repoB, stdio: "pipe" });
      const firstSha = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoB,
        encoding: "utf8",
      }).stdout.trim();

      // Add a second file and commit
      writeFileSync(join(repoB, "b.txt"), "second\n");
      execSync("git add b.txt", { cwd: repoB, stdio: "pipe" });
      execSync('git commit -m "second"', { cwd: repoB, stdio: "pipe" });

      const manifest = buildIncrementalManifest(repoB, firstSha);
      expect(manifest.tracked.length).toBeGreaterThan(0);
      // Decoding the base64 should yield a non-empty diff
      const decoded = Buffer.from(manifest.tracked, "base64");
      expect(decoded.length).toBeGreaterThan(0);
    } finally {
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("untrackedManifest contains untracked files", () => {
    const repoC = mkdtempSync(join(tmpdir(), "wsync-incr-c-"));
    try {
      execSync("git init -b main", { cwd: repoC, stdio: "pipe" });
      execSync('git config user.email "t@t.com"', { cwd: repoC, stdio: "pipe" });
      execSync('git config user.name "T"', { cwd: repoC, stdio: "pipe" });
      writeFileSync(join(repoC, "tracked.txt"), "tracked\n");
      execSync("git add tracked.txt", { cwd: repoC, stdio: "pipe" });
      execSync('git commit -m "init"', { cwd: repoC, stdio: "pipe" });
      const sha = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoC,
        encoding: "utf8",
      }).stdout.trim();

      // Add an untracked file
      writeFileSync(join(repoC, "untracked.txt"), "not committed\n");

      const manifest = buildIncrementalManifest(repoC, sha);
      const paths = manifest.untrackedManifest.map((e) => e.path);
      expect(paths).toContain("untracked.txt");

      // Each entry has sha256 (64 chars) and size
      const entry = manifest.untrackedManifest.find(
        (e) => e.path === "untracked.txt",
      );
      expect(entry).toBeDefined();
      expect(entry!.sha256).toHaveLength(64);
      expect(entry!.size).toBeGreaterThan(0);
    } finally {
      rmSync(repoC, { recursive: true, force: true });
    }
  });

  it("untrackedManifest is empty when all files are tracked", () => {
    const manifest = buildIncrementalManifest(tmpRepo, initialSha);
    // tmpRepo only has hello.txt which is tracked; no untracked files.
    expect(manifest.untrackedManifest).toHaveLength(0);
  });

  it("deleted/renames/modes are empty arrays (prototype)", () => {
    const manifest = buildIncrementalManifest(tmpRepo, initialSha);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renames).toEqual([]);
    expect(manifest.modes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. buildUntrackedTarball
// ---------------------------------------------------------------------------

describe("buildUntrackedTarball", () => {
  it("returns empty Buffer when paths is empty", () => {
    const buf = buildUntrackedTarball(tmpRepo, []);
    expect(buf.byteLength).toBe(0);
  });

  it("creates a non-empty tarball for existing files", () => {
    // tmpRepo/hello.txt exists; we can tar it even though it is tracked —
    // the function does not filter by git status.
    const buf = buildUntrackedTarball(tmpRepo, ["hello.txt"]);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it("produces a tarball that can be extracted", () => {
    // Use a fresh dir with a known file.
    const repoD = mkdtempSync(join(tmpdir(), "wsync-incr-d-"));
    const extractDir = mkdtempSync(join(tmpdir(), "wsync-extract-"));
    try {
      writeFileSync(join(repoD, "payload.txt"), "payload content\n");
      const buf = buildUntrackedTarball(repoD, ["payload.txt"]);
      expect(buf.byteLength).toBeGreaterThan(0);

      // Extract and verify content is present.
      const res = spawnSync("tar", ["-xzf", "-", "-C", extractDir], {
        input: buf,
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(res.status).toBe(0);

      // The extracted file should exist.
      const extracted = spawnSync(
        "cat",
        [join(extractDir, "payload.txt")],
        { encoding: "utf8" },
      );
      expect(extracted.stdout).toContain("payload content");
    } finally {
      rmSync(repoD, { recursive: true, force: true });
      rmSync(extractDir, { recursive: true, force: true });
    }
  });
});
