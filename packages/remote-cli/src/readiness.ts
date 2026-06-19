/**
 * readiness.ts — Phase A
 *
 * Best-effort, network-free readiness check before a session migration.
 * All checks use spawnSync only — no network calls, never throws.
 *
 * Exported: checkReadiness(opts?) → ReadinessResult
 */

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReadinessResult = {
  ready: boolean;
  mode: "full" | "lazy";
  blockers: string[];
  pending: { files: number; bytes: number; est_seconds: number };
};

export type CheckReadinessOptions = {
  /** Override process.cwd() for tests. */
  cwd?: string;
  /** Override spawnSync for tests. */
  spawnImpl?: typeof spawnSync;
};

// ---------------------------------------------------------------------------
// Thresholds for lazy mode
// ---------------------------------------------------------------------------

/** Max files in working set before switching to "lazy" mode. */
const LAZY_FILES_THRESHOLD = 200;

/** Max total bytes (50 MB) in working set before switching to "lazy" mode. */
const LAZY_BYTES_THRESHOLD = 50 * 1024 * 1024;

/** Transfer rate estimate: 10 MB/s */
const TRANSFER_RATE_BYTES_PER_SEC = 10_000_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Check whether the local workspace is ready for a session migration.
 *
 * All checks are best-effort and synchronous (no network, no throws).
 * Returns a structured ReadinessResult.
 */
export function checkReadiness(
  opts: CheckReadinessOptions = {},
): ReadinessResult {
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawnImpl ?? spawnSync;

  const blockers: string[] = [];
  let mode: "full" | "lazy" = "full";

  // ------------------------------------------------------------------
  // auth_ok — `remote auth status` rc=0
  // ------------------------------------------------------------------
  try {
    const authResult = spawn("remote", ["auth", "status"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (authResult.status !== 0) {
      blockers.push("auth: CLI not authenticated");
    }
  } catch {
    blockers.push("auth: CLI not authenticated");
  }

  // ------------------------------------------------------------------
  // repo_bootstrapped — `git rev-parse HEAD` rc=0
  // ------------------------------------------------------------------
  let gitOk = false;
  try {
    const gitResult = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
    });
    gitOk = gitResult.status === 0;
    if (!gitOk) {
      blockers.push("repo: not a git repository");
    }
  } catch {
    blockers.push("repo: not a git repository");
  }

  // ------------------------------------------------------------------
  // plugins_parity_ok — non-blocking warning
  // Not all profiles have a plugin manifest; absence is not a blocker.
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // conv_resolvable — non-blocking warning
  // Conversation path check; not all profiles support path-keyed convs.
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // deps_rebuilt — no-op in local mode
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // hot_set_synced — in "full" mode, check working set size
  // Only meaningful when we have a git repo
  // ------------------------------------------------------------------
  let pendingFiles = 0;
  let pendingBytes = 0;

  if (gitOk) {
    try {
      // Modified/staged files relative to HEAD
      const diffResult = spawn(
        "git",
        ["diff", "--name-only", "HEAD", "--"],
        {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      // Untracked files (not in .gitignore)
      const untrackedResult = spawn(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
        },
      );

      const diffLines =
        diffResult.status === 0 && diffResult.stdout
          ? (diffResult.stdout as string)
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
          : [];

      const untrackedLines =
        untrackedResult.status === 0 && untrackedResult.stdout
          ? (untrackedResult.stdout as string)
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
          : [];

      const allPendingFiles = [...new Set([...diffLines, ...untrackedLines])];
      pendingFiles = allPendingFiles.length;

      // Estimate bytes for pending files
      for (const file of allPendingFiles) {
        try {
          const filePath = join(cwd, file);
          if (existsSync(filePath)) {
            pendingBytes += statSync(filePath).size;
          }
        } catch {
          // best-effort: skip files we can't stat
        }
      }

      // Switch to lazy if working set is too large
      if (
        pendingFiles >= LAZY_FILES_THRESHOLD ||
        pendingBytes >= LAZY_BYTES_THRESHOLD
      ) {
        mode = "lazy";
      }
    } catch {
      // best-effort: if git commands fail, leave pendingFiles/pendingBytes at 0
    }
  }

  const est_seconds = Math.ceil(pendingBytes / TRANSFER_RATE_BYTES_PER_SEC);

  const ready = blockers.length === 0;

  return {
    ready,
    mode,
    blockers,
    pending: {
      files: pendingFiles,
      bytes: pendingBytes,
      est_seconds,
    },
  };
}
