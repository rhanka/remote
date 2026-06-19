import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export function sha256Buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Buf(readFileSync(path));
}

// ---------------------------------------------------------------------------
// Git introspection
// ---------------------------------------------------------------------------

export function isGitRepo(cwd: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" })
      .status === 0
  );
}

export function getHeadSha(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Bootstrap: full git bundle
// ---------------------------------------------------------------------------

/**
 * Create a git bundle of all local refs (HEAD + all branches).
 * Used for the first-time push when no base commit is known on the CP side.
 */
export function buildGitBundle(cwd: string): Buffer {
  const r = spawnSync("git", ["bundle", "create", "-", "--all"], {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `git bundle failed: ${r.stderr?.toString()?.slice(0, 200) ?? "unknown error"}`,
    );
  }
  return r.stdout as Buffer;
}

// ---------------------------------------------------------------------------
// Incremental: tracked diff (committed + staged changes since baseSha)
// ---------------------------------------------------------------------------

/**
 * Build a binary git diff between baseSha and HEAD (committed changes) plus
 * staged index changes, combined and base64-encoded for transport.
 */
export function buildTrackedDiff(cwd: string, baseSha: string): string {
  const opts = {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  };
  // Committed changes between baseSha and HEAD
  const rCommitted = spawnSync(
    "git",
    ["diff", "--binary", baseSha, "HEAD"],
    opts,
  );
  // Staged (index) changes not yet committed
  const rStaged = spawnSync(
    "git",
    ["diff", "--binary", "--cached", "HEAD"],
    opts,
  );
  const combined = Buffer.concat([
    (rCommitted.stdout as Buffer | null) ?? Buffer.alloc(0),
    (rStaged.stdout as Buffer | null) ?? Buffer.alloc(0),
  ]);
  return combined.toString("base64");
}

// ---------------------------------------------------------------------------
// Incremental: untracked files manifest + tarball
// ---------------------------------------------------------------------------

export type UntrackedEntry = { path: string; sha256: string; size: number };

export type IncrementalManifest = {
  base: string;
  tracked: string; // base64 git diff --binary
  untrackedManifest: UntrackedEntry[];
  deleted: string[];
  renames: Array<{ from: string; to: string }>;
  modes: Array<{ path: string; mode: string }>;
};

/**
 * Build the full incremental manifest: tracked diff + untracked file list.
 * Does NOT build the tarball (caller calls buildUntrackedTarball separately).
 */
export function buildIncrementalManifest(
  cwd: string,
  baseSha: string,
): IncrementalManifest {
  const tracked = buildTrackedDiff(cwd, baseSha);

  // List untracked files not excluded by .gitignore
  const utR = spawnSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], {
    cwd,
    encoding: "buffer",
  });
  const untrackedPaths = (utR.stdout as Buffer)
    .toString("utf8")
    .split("\0")
    .map((p) => p.trim())
    .filter(Boolean);

  const untrackedManifest: UntrackedEntry[] = untrackedPaths.map((p) => {
    const abs = join(cwd, p);
    return { path: p, sha256: sha256File(abs), size: statSync(abs).size };
  });

  return {
    base: baseSha,
    tracked,
    untrackedManifest,
    deleted: [],
    renames: [],
    modes: [],
  };
}

/**
 * Build a gzip tarball of the specified untracked file paths relative to cwd.
 * Returns an empty Buffer if paths is empty.
 */
export function buildUntrackedTarball(cwd: string, paths: string[]): Buffer {
  if (paths.length === 0) return Buffer.alloc(0);
  const input = paths.join("\0");
  // Note: -C must precede -T on GNU tar (positional option ordering).
  const r = spawnSync("tar", ["-czf", "-", "-C", cwd, "--null", "-T", "-"], {
    input: Buffer.from(input),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `tar untracked failed: ${r.stderr?.toString()?.slice(0, 200) ?? "unknown error"}`,
    );
  }
  return r.stdout as Buffer;
}
