import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  applyStorageRedirect,
  planStorageRedirect,
} from "./redirect-storage.js";

// Scratch lives under the package (gitignored .state-test/), never /tmp.
const SCRATCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".state-test");

function tmp(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("planStorageRedirect", () => {
  it("puts caches/tmp on the scratch mount, worktrees on the RWX workspace", () => {
    const plan = planStorageRedirect({
      workspacePath: "/workspace",
      home: "/root",
      scratch: "/scratch",
      env: {},
    });
    expect(plan.dirs).toEqual([
      "/scratch/tmp",
      "/scratch/cache",
      "/scratch/cache/npm",
      "/scratch/cargo",
      "/scratch/cache/pip",
      "/workspace/.worktrees",
    ]);
    // legacy global superpowers worktree path symlinked onto the RWX base
    expect(plan.symlinks).toEqual([
      {
        link: "/root/.config/superpowers/worktrees",
        target: "/workspace/.worktrees",
      },
    ]);
  });

  it("worktree base follows a non-default workspacePath; caches stay on scratch", () => {
    const plan = planStorageRedirect({
      workspacePath: "/data/ws",
      home: "/home/antoinefa",
      scratch: "/scratch",
      env: {},
    });
    expect(plan.dirs).toContain("/scratch/tmp");
    expect(plan.dirs).toContain("/scratch/cache/npm");
    expect(plan.dirs).toContain("/data/ws/.worktrees");
    expect(plan.symlinks[0]).toEqual({
      link: "/home/antoinefa/.config/superpowers/worktrees",
      target: "/data/ws/.worktrees",
    });
  });

  it("prefers the env-provided values when present (matches the k8s env vars)", () => {
    const plan = planStorageRedirect({
      workspacePath: "/workspace",
      home: "/root",
      env: {
        TMPDIR: "/workspace/.tmp",
        XDG_CACHE_HOME: "/workspace/.cache",
        npm_config_cache: "/workspace/.cache/npm",
        CARGO_HOME: "/workspace/.cargo",
        PIP_CACHE_DIR: "/workspace/.cache/pip",
        SUPERPOWERS_WORKTREE_BASE: "/workspace/.worktrees",
      },
    });
    expect(plan.dirs).toContain("/workspace/.worktrees");
    expect(plan.symlinks[0]?.target).toBe("/workspace/.worktrees");
  });
});

describe("applyStorageRedirect", () => {
  it("creates the dirs and the worktree symlink, idempotently", () => {
    const root = tmp("redirect-");
    const ws = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });

    const scratch = join(root, "scratch");
    const plan = planStorageRedirect({ workspacePath: ws, home, scratch, env: {} });
    const first = applyStorageRedirect(plan);
    // every dir created + the one symlink
    expect(first.length).toBe(plan.dirs.length + 1);

    const link = join(home, ".config/superpowers/worktrees");
    const st = lstatSync(link);
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(ws, ".worktrees"));

    // Re-run: dirs already exist (mkdir -p is a no-op success) but the symlink
    // is skipped (already points at the right target), so the symlink is NOT
    // re-reported.
    const second = applyStorageRedirect(plan);
    expect(second.some((m) => m.startsWith("symlink "))).toBe(false);
  });

  it("leaves a pre-existing real path at the symlink location untouched", () => {
    const root = tmp("redirect-real-");
    const ws = join(root, "workspace");
    const home = join(root, "home");
    const link = join(home, ".config/superpowers/worktrees");
    mkdirSync(dirname(link), { recursive: true });
    // A real directory already sits where the symlink would go.
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "keep.txt"), "preexisting");

    const plan = planStorageRedirect({
      workspacePath: ws,
      home,
      scratch: join(root, "scratch"),
      env: {},
    });
    applyStorageRedirect(plan);

    // Untouched: still a directory, file preserved (not clobbered by a symlink).
    expect(lstatSync(link).isDirectory()).toBe(true);
  });

  it("adopts a correct pre-existing symlink without recreating it", () => {
    const root = tmp("redirect-existing-link-");
    const ws = join(root, "workspace");
    const home = join(root, "home");
    const target = join(ws, ".worktrees");
    const link = join(home, ".config/superpowers/worktrees");
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);

    const plan = planStorageRedirect({
      workspacePath: ws,
      home,
      scratch: join(root, "scratch"),
      env: {},
    });
    const done = applyStorageRedirect(plan);
    expect(done.some((m) => m.startsWith("symlink "))).toBe(false);
    expect(readlinkSync(link)).toBe(target);
  });
});
