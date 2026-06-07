/**
 * Git workspace alignment check for `remote diff --files`: compare the LOCAL
 * workspace's git state with the session Pod's ($WORKSPACE_PATH), via kubectl
 * exec. Only HEAD shas, branch names and modified file NAMES cross the wire —
 * never any file content.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { getTunnel } from "./config.js";

export type GitStat = {
  head: string;
  branch: string;
  /** Modified/untracked file names from `git status --porcelain` (names only). */
  dirty: string[];
};

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** File names (only) out of `git status --porcelain` output. */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    let p = line.slice(3); // "XY <path>"
    const arrow = p.indexOf(" -> "); // rename: "old -> new" — keep the new name
    if (arrow !== -1) p = p.slice(arrow + 4);
    files.push(p.replace(/^"(.*)"$/, "$1"));
  }
  return files;
}

/** Git state of the LOCAL workspace directory (or undefined if not a repo). */
export function localGitStat(workspacePath: string): GitStat | undefined {
  const run = (args: string[]) =>
    spawnSync("git", ["-C", workspacePath, ...args], { encoding: "utf8" });
  const head = run(["rev-parse", "HEAD"]);
  if (head.status !== 0) return undefined;
  return {
    head: head.stdout.trim(),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    dirty: parsePorcelain(run(["status", "--porcelain"]).stdout),
  };
}

/** Git state of the Pod's $WORKSPACE_PATH (computed in-Pod, names only). */
export function remoteGitStat(sessionId: string): GitStat | undefined {
  const tunnel = getTunnel();
  if (!tunnel) return undefined;
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const script =
    `cd "$WORKSPACE_PATH" || exit 1; ` +
    `git rev-parse HEAD 2>/dev/null || exit 1; ` +
    `git rev-parse --abbrev-ref HEAD 2>/dev/null; ` +
    `git status --porcelain 2>/dev/null`;
  const r = spawnSync(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "exec",
      `session-${sessionId}`,
      "-c",
      "session-agent",
      "--",
      "bash",
      "-lc",
      script,
    ],
    { encoding: "utf8", env },
  );
  if (r.status !== 0) return undefined;
  const lines = r.stdout.split("\n");
  const head = (lines[0] ?? "").trim();
  if (!head) return undefined;
  return {
    head,
    branch: (lines[1] ?? "").trim(),
    dirty: parsePorcelain(lines.slice(2).join("\n")),
  };
}

export type Ancestry = "local-ahead" | "remote-ahead" | "unknown";

/**
 * Which HEAD descends from the other, resolved with LOCAL git objects only
 * (the remote HEAD is usually known locally after a fetch; otherwise unknown).
 */
export function localAncestry(
  workspacePath: string,
  localHead: string,
  remoteHead: string,
): Ancestry {
  const isAncestor = (a: string, b: string) =>
    spawnSync("git", ["-C", workspacePath, "merge-base", "--is-ancestor", a, b], {
      encoding: "utf8",
    }).status === 0;
  if (isAncestor(remoteHead, localHead)) return "local-ahead";
  if (isAncestor(localHead, remoteHead)) return "remote-ahead";
  return "unknown";
}

export type GitVerdict = {
  state: "in-sync" | "local-ahead" | "remote-ahead" | "diverged" | "missing";
  detail: string;
};

function names(files: string[]): string {
  return files.length <= 4
    ? files.join(", ")
    : `${files.slice(0, 4).join(", ")}, +${files.length - 4} more`;
}

/** Pure verdict from both git states (+ HEAD ancestry when heads differ). */
export function gitAlignment(
  local: GitStat | undefined,
  remote: GitStat | undefined,
  ancestry: Ancestry = "unknown",
): GitVerdict {
  if (!local && !remote) return { state: "missing", detail: "no git repo either side" };
  if (!remote) {
    return { state: "missing", detail: "Pod workspace is not a git repo (or unreachable)" };
  }
  if (!local) return { state: "missing", detail: "local workspace is not a git repo" };

  const sameHead = local.head === remote.head;
  const branchTxt =
    local.branch === remote.branch
      ? `branch ${local.branch}`
      : `branch ${local.branch} (local) vs ${remote.branch} (remote)`;
  const headTxt = sameHead
    ? `HEAD ${local.head.slice(0, 7)} identical`
    : `HEAD differs: ${local.head.slice(0, 7)} (local) vs ${remote.head.slice(0, 7)} (remote)`;
  const dirtyTxt = [
    local.dirty.length > 0 ? `local modified: ${names(local.dirty)}` : "local clean",
    remote.dirty.length > 0 ? `remote modified: ${names(remote.dirty)}` : "remote clean",
  ].join("; ");
  const detail = `${headTxt} [${branchTxt}] — ${dirtyTxt}`;

  if (sameHead) {
    if (local.dirty.length === 0 && remote.dirty.length === 0)
      return { state: "in-sync", detail };
    if (remote.dirty.length === 0) return { state: "local-ahead", detail };
    if (local.dirty.length === 0) return { state: "remote-ahead", detail };
    return { state: "diverged", detail: `${detail} (both sides modified)` };
  }
  if (ancestry === "local-ahead" && remote.dirty.length === 0) {
    return { state: "local-ahead", detail: `${detail} (remote HEAD is an ancestor of local)` };
  }
  if (ancestry === "remote-ahead" && local.dirty.length === 0) {
    return { state: "remote-ahead", detail: `${detail} (local HEAD is an ancestor of remote)` };
  }
  return { state: "diverged", detail };
}
