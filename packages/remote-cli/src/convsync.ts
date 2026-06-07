/**
 * Conversation alignment check: is a remote session's conversation log in sync
 * with the latest LOCAL conversation for the same project? Compares metrics only
 * (id, bytes, lines, sha256) — local read directly, remote computed in-Pod via
 * kubectl (only the numbers cross the wire, never the conversation content).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { getTunnel } from "./config.js";

const CLAUDE_PROJECTS = ".claude/projects";

export type ConvStat = {
  convId: string;
  bytes: number;
  lines: number;
  sha: string;
};

/** claude's cwd→project-dir encoding (slashes → dashes). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Newest local conversation for a project path (or undefined). */
export function localConvStat(
  workspacePath: string,
  home: string = homedir(),
): ConvStat | undefined {
  const dir = join(home, CLAUDE_PROJECTS, encodeCwd(workspacePath));
  if (!existsSync(dir)) return undefined;
  let newest: { name: string; mtimeMs: number } | undefined;
  for (const e of readdirSync(dir)) {
    if (!e.endsWith(".jsonl")) continue;
    const st = statSync(join(dir, e));
    if (!newest || st.mtimeMs > newest.mtimeMs) {
      newest = { name: e, mtimeMs: st.mtimeMs };
    }
  }
  if (!newest) return undefined;
  const buf = readFileSync(join(dir, newest.name));
  return {
    convId: newest.name.replace(/\.jsonl$/, ""),
    bytes: buf.byteLength,
    lines: buf.toString("utf8").split("\n").filter(Boolean).length,
    sha: createHash("sha256").update(buf).digest("hex").slice(0, 12),
  };
}

/** Newest remote conversation for a session (computed in-Pod, metrics only). */
export function remoteConvStat(
  sessionId: string,
  workspacePath: string,
): ConvStat | undefined {
  const tunnel = getTunnel();
  if (!tunnel) return undefined;
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const enc = encodeCwd(workspacePath);
  const script =
    `d="$HOME/${CLAUDE_PROJECTS}/${enc}"; ` +
    `f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -1); ` +
    `[ -z "$f" ] && exit 1; ` +
    `printf '%s\\t%s\\t%s\\t%s' ` +
    `"$(basename "$f" .jsonl)" "$(wc -c <"$f")" "$(wc -l <"$f")" "$(sha256sum "$f" | cut -c1-12)"`;
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
  const [convId, bytes, lines, sha] = r.stdout.trim().split("\t");
  if (!convId) return undefined;
  return { convId, bytes: Number(bytes), lines: Number(lines), sha: sha ?? "" };
}

export type AlignVerdict = {
  state: "in-sync" | "local-ahead" | "remote-ahead" | "diverged" | "missing";
  detail: string;
};

export function alignment(
  local: ConvStat | undefined,
  remote: ConvStat | undefined,
): AlignVerdict {
  if (!local && !remote) return { state: "missing", detail: "no conversation either side" };
  if (!remote) return { state: "missing", detail: "remote has no conversation" };
  if (!local) return { state: "remote-ahead", detail: "no local conversation (remote-only)" };
  if (local.convId !== remote.convId) {
    return {
      state: "diverged",
      detail: `different conversations — local newest ${local.convId} vs remote ${remote.convId} (separate sessions)`,
    };
  }
  if (local.sha === remote.sha) {
    return { state: "in-sync", detail: `identical (${local.lines} lines, ${(local.bytes / 1024 / 1024).toFixed(1)}M)` };
  }
  if (local.bytes > remote.bytes) {
    return {
      state: "local-ahead",
      detail: `local +${local.lines - remote.lines} lines — push: re-deport (safe, remote is behind)`,
    };
  }
  if (remote.bytes > local.bytes) {
    return {
      state: "remote-ahead",
      detail: `remote +${remote.lines - local.lines} lines — pull: 'remote migrate back' (do NOT re-deport, it would overwrite remote)`,
    };
  }
  return { state: "diverged", detail: "same conversation, content differs (both edited)" };
}
