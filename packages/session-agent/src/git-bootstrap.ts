/**
 * Clone-on-start: make the workspace a real git repo without transferring a
 * large `.git`. When the migrated archive carried no `.git` (size-gated by the
 * CLI) but recorded the origin in `.remote/git.json`, the agent fetches the
 * history from origin (gh auth is bundled) directly onto the workspace volume,
 * then resets index/HEAD to the fetched commit while KEEPING the working tree
 * (the pushed files, possibly with uncommitted changes). Result: commit/push
 * work in the Pod and the uncommitted diff is preserved.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Rewrite a GitHub SSH origin to HTTPS so the bundled gh token can auth it. */
function normalizeGithubOrigin(origin: string): string {
  const scp = /^git@github\.com:(.+?)(?:\.git)?$/.exec(origin);
  if (scp) return `https://github.com/${scp[1]}.git`;
  const ssh = /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/.exec(origin);
  if (ssh) return `https://github.com/${ssh[1]}.git`;
  return origin;
}

export function bootstrapGit(workspacePath: string): string | undefined {
  if (existsSync(join(workspacePath, ".git"))) return undefined; // already a repo
  const metaPath = join(workspacePath, ".remote", "git.json");
  if (!existsSync(metaPath)) return undefined;

  let meta: { origin?: string; branch?: string; head?: string };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return undefined;
  }
  if (!meta.origin) return undefined;

  const origin = normalizeGithubOrigin(meta.origin);
  const branch = meta.branch && meta.branch !== "HEAD" ? meta.branch : "";
  const run = (args: ReadonlyArray<string>): boolean =>
    spawnSync(args[0]!, args.slice(1), {
      cwd: workspacePath,
      stdio: "ignore",
    }).status === 0;

  // Use the bundled gh token as the git credential helper for github https.
  spawnSync("gh", ["auth", "setup-git"], { cwd: workspacePath, stdio: "ignore" });

  run(["git", "init", "-q", ...(branch ? ["-b", branch] : [])]);
  run(["git", "remote", "add", "origin", origin]);
  const fetched = run([
    "git",
    "fetch",
    "-q",
    "--depth=200",
    "origin",
    ...(branch ? [branch] : []),
  ]);
  if (!fetched) {
    return `git bootstrap: fetch from ${origin} failed (auth/network) — restore manually`;
  }
  // Set branch + index to the fetched commit, keep the working tree intact.
  run(["git", "reset", "--mixed", "-q", "FETCH_HEAD"]);
  if (branch) {
    run(["git", "branch", `--set-upstream-to=origin/${branch}`, branch]);
  }
  return `git ready from ${origin}${branch ? ` @ ${branch}` : ""}`;
}
