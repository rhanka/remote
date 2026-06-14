import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Belt-and-braces companion to the k8s-orchestrator env vars: caches/tmp
 * (TMPDIR, XDG_CACHE_HOME, npm_config_cache, CARGO_HOME, PIP_CACHE_DIR) point at
 * the bounded node-local scratch emptyDir (SCRATCH_MOUNT), while worktrees
 * (SUPERPOWERS_WORKTREE_BASE) point at the persistent RWX workspace.
 *
 * The env vars stop NEW heavy/temp/cache writes from piling onto the node's
 * shared ephemeral overlay unbounded (which DiskPressure-cascade-evicted whole
 * nodes); the scratch emptyDir's sizeLimit caps a single pod instead. But two
 * things still need help at startup:
 *
 *   1. The target dirs must EXIST before the tools first write to them
 *      (npm/cargo/pip don't always mkdir -p their cache root).
 *   2. superpowers `using-git-worktrees` does NOT read an env var for its base;
 *      it falls back to a legacy GLOBAL path `~/.config/superpowers/worktrees`.
 *      Symlinking that path onto the RWX `<workspace>/.worktrees` makes worktrees
 *      created there PERSIST across pod restarts regardless of how superpowers
 *      picks the path. (Its other branch, repo-relative `.worktrees/<branch>`,
 *      already lands inside the cloned repo on the RWX workspace.)
 *
 * Pure planner so the behavior is unit-testable without touching the fs.
 */

export type StoragePlan = {
  /** Absolute dirs to `mkdir -p` (idempotent). */
  readonly dirs: ReadonlyArray<string>;
  /**
   * Symlinks to create as `link -> target`. Applied idempotently: skipped when
   * `link` is already a symlink to `target`. The parent of `link` is created
   * first (it lives on the ephemeral HOME, which starts empty on each pod).
   */
  readonly symlinks: ReadonlyArray<{ readonly link: string; readonly target: string }>;
};

/**
 * Build the mkdir + symlink plan from the resolved env. `workspacePath` is the
 * RWX mount (WORKSPACE_PATH); `home` is HOME. Falls back to the env-derived
 * cache/tmp/cargo paths but recomputes them from `workspacePath` when unset so
 * the plan is correct even if a single var was dropped.
 */
export function planStorageRedirect(input: {
  readonly workspacePath: string;
  readonly home: string;
  /** Mount of the bounded node-local scratch emptyDir (SCRATCH_MOUNT, default
   * "/scratch") where caches/tmp live — OFF the shared RWX. */
  readonly scratch?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): StoragePlan {
  const ws = input.workspacePath;
  const scratch = input.scratch ?? "/scratch";
  const env = input.env ?? {};
  // Caches/tmp default onto the bounded scratch emptyDir (fast node-local,
  // not the shared RWX); worktrees default onto the RWX (persistent).
  const tmpdir = env.TMPDIR ?? `${scratch}/tmp`;
  const xdgCache = env.XDG_CACHE_HOME ?? `${scratch}/cache`;
  const npmCache = env.npm_config_cache ?? `${scratch}/cache/npm`;
  const cargoHome = env.CARGO_HOME ?? `${scratch}/cargo`;
  const pipCache = env.PIP_CACHE_DIR ?? `${scratch}/cache/pip`;
  const worktreeBase = env.SUPERPOWERS_WORKTREE_BASE ?? `${ws}/.worktrees`;

  // Dedupe while preserving order (parents before children isn't required —
  // mkdir -p makes intermediates — but a stable, deduped list is tidy).
  const dirs = Array.from(
    new Set([tmpdir, xdgCache, npmCache, cargoHome, pipCache, worktreeBase]),
  );

  // Legacy GLOBAL superpowers worktree dir → RWX worktree base. This is the
  // path superpowers uses when no project-local `.worktrees/` is found, so
  // symlinking it is what guarantees worktrees survive a restart even when the
  // tool ignores the env var.
  const superpowersGlobal = `${input.home}/.config/superpowers/worktrees`;

  return {
    dirs,
    symlinks: [{ link: superpowersGlobal, target: worktreeBase }],
  };
}

/**
 * Apply a {@link StoragePlan} idempotently. Best-effort per item: a failure on
 * one dir/symlink is logged and skipped, never fatal (the session must still
 * start). Returns a terse list of what it created, for a single startup log.
 */
export function applyStorageRedirect(
  plan: StoragePlan,
  log: (msg: string) => void = () => {},
): ReadonlyArray<string> {
  const done: string[] = [];
  for (const dir of plan.dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      done.push(`mkdir ${dir}`);
    } catch (error) {
      log(`[session-agent] mkdir ${dir} failed: ${String(error)}`);
    }
  }
  for (const { link, target } of plan.symlinks) {
    try {
      // Skip if already a symlink to the same target (idempotent re-run).
      try {
        const st = lstatSync(link);
        if (st.isSymbolicLink() && readlinkSync(link) === target) {
          continue;
        }
        // A real (non-symlink) path already occupies `link` — leave it alone
        // rather than clobber user/tool state.
        log(
          `[session-agent] symlink ${link} skipped: path exists and is not the expected symlink`,
        );
        continue;
      } catch {
        // ENOENT — nothing there yet, fall through and create it.
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      done.push(`symlink ${link} -> ${target}`);
    } catch (error) {
      log(`[session-agent] symlink ${link} -> ${target} failed: ${String(error)}`);
    }
  }
  return done;
}
