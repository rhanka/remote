/**
 * Conversation sync between local and a session Pod (`remote sync`): copy the
 * conversation .jsonl in either direction over `kubectl exec`, base64 on the
 * wire (encoded exactly ONCE — never double-encode, that was a real bug), with
 * an ahead-GUARD so the side that has MORE of the conversation is never
 * silently overwritten (--force to override), and a `.bak-<epoch>` backup of
 * whatever gets overwritten, taken BEFORE writing. Conversation content is
 * transferred verbatim but never printed.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getTunnel, type TunnelConfig } from "./config.js";
import { encodeCwd, localConvStat, remoteConvStat } from "./convsync.js";

const CLAUDE_PROJECTS = ".claude/projects";

export type SyncDirection = "push" | "pull";

export type SyncDecision = { allow: true } | { allow: false; reason: string };

/**
 * Pure GUARD: never overwrite the side that has MORE of the conversation.
 * `pull` overwrites local → refuse if local is ahead; `push` overwrites the
 * Pod → refuse if remote is ahead. `--force` overrides (a backup is still
 * taken either way).
 */
export function decideSyncAction(args: {
  localLines: number;
  remoteLines: number;
  direction: SyncDirection;
  force: boolean;
}): SyncDecision {
  const { localLines, remoteLines, direction, force } = args;
  if (force) return { allow: true };
  if (direction === "pull" && localLines > remoteLines) {
    return {
      allow: false,
      reason:
        `local conversation is ahead (${localLines} vs ${remoteLines} lines) — ` +
        `pull would lose ${localLines - remoteLines} local line(s). ` +
        `Push instead, or re-run with --force to overwrite local anyway.`,
    };
  }
  if (direction === "push" && remoteLines > localLines) {
    return {
      allow: false,
      reason:
        `remote conversation is ahead (${remoteLines} vs ${localLines} lines) — ` +
        `push would lose ${remoteLines - localLines} remote line(s). ` +
        `Pull instead, or re-run with --force to overwrite remote anyway.`,
    };
  }
  return { allow: true };
}

/** Local path of a conversation file for a workspace (claude cwd encoding). */
export function localConvFile(
  workspacePath: string,
  convId: string,
  home: string = homedir(),
): string {
  return join(home, CLAUDE_PROJECTS, encodeCwd(workspacePath), `${convId}.jsonl`);
}

/** Pod-side conversation path, relative to $HOME (used as "$HOME/<rel>"). */
export function remoteConvRel(workspacePath: string, convId: string): string {
  return `${CLAUDE_PROJECTS}/${encodeCwd(workspacePath)}/${convId}.jsonl`;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Exec a bash -lc script in the session-agent container. Throws on non-zero. */
function execPod(
  tunnel: TunnelConfig,
  pod: string,
  script: string,
  input?: string,
): string {
  const args = ["-n", tunnel.namespace, "exec"];
  if (input !== undefined) args.push("-i");
  args.push(pod, "-c", "session-agent", "--", "bash", "-lc", script);
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const r = spawnSync("kubectl", args, {
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024 * 1024, // conversations can be many MB of base64
    ...(input !== undefined ? { input } : {}),
  });
  if (r.status !== 0) {
    // stderr only (kubectl/bash diagnostics) — never conversation content.
    throw new Error(`kubectl exec failed: ${(r.stderr || "").trim().slice(0, 200)}`);
  }
  return r.stdout;
}

/** Non-empty line count of a local file (same convention as convsync). */
function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

export type SyncResult =
  | {
      ok: true;
      direction: SyncDirection;
      convId: string;
      lines: { local: number; remote: number };
      /** Path of the .bak-<epoch> taken (undefined if nothing was overwritten). */
      backup: string | undefined;
      /** Destination written (local path, or "$HOME/<rel>" on the Pod). */
      written: string;
    }
  | { ok: false; reason: string };

/**
 * Copy the conversation .jsonl between local and the Pod. `pull`: Pod → local
 * (guard: refuse if local is ahead). `push`: local → Pod (guard: refuse if
 * remote is ahead). Both back up the overwritten file as `.bak-<epoch>` first.
 */
export function syncConversation(args: {
  sessionId: string;
  workspacePath: string;
  direction: SyncDirection;
  force: boolean;
}): SyncResult {
  const { sessionId, workspacePath, direction, force } = args;
  const tunnel = getTunnel();
  if (!tunnel) {
    throw new Error("sync needs a tunnel configured (remote config tunnel …)");
  }
  const pod = `session-${sessionId}`;
  const epoch = Math.floor(Date.now() / 1000);

  if (direction === "pull") {
    const remote = remoteConvStat(sessionId, workspacePath);
    if (!remote) {
      return { ok: false, reason: "remote has no conversation (or the Pod is unreachable)" };
    }
    const dst = localConvFile(workspacePath, remote.convId);
    const localLines = countLines(dst);
    const decision = decideSyncAction({
      localLines,
      remoteLines: remote.lines,
      direction,
      force,
    });
    if (!decision.allow) return { ok: false, reason: decision.reason };
    const rel = remoteConvRel(workspacePath, remote.convId);
    // Encoded ONCE in the Pod, decoded ONCE here — never re-encode.
    const b64 = execPod(tunnel, pod, `base64 < "$HOME/${rel}" | tr -d '\\n'`);
    const buf = Buffer.from(b64.trim(), "base64");
    let backup: string | undefined;
    if (existsSync(dst)) {
      backup = `${dst}.bak-${epoch}`;
      copyFileSync(dst, backup); // BEFORE overwriting
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
    return {
      ok: true,
      direction,
      convId: remote.convId,
      lines: { local: localLines, remote: remote.lines },
      backup,
      written: dst,
    };
  }

  // push: local → Pod.
  const local = localConvStat(workspacePath);
  if (!local) {
    return { ok: false, reason: "no local conversation for this workspace" };
  }
  const src = localConvFile(workspacePath, local.convId);
  const rel = remoteConvRel(workspacePath, local.convId);
  const probe = execPod(
    tunnel,
    pod,
    `f="$HOME/${rel}"; if [ -f "$f" ]; then printf 'yes\\t%s' "$(wc -l <"$f")"; else printf 'no\\t0'; fi`,
  )
    .trim()
    .split("\t");
  const remoteExists = probe[0] === "yes";
  const remoteLines = Number(probe[1] ?? 0) || 0;
  const decision = decideSyncAction({
    localLines: local.lines,
    remoteLines,
    direction,
    force,
  });
  if (!decision.allow) return { ok: false, reason: decision.reason };
  // Encoded ONCE here, decoded ONCE in the Pod — never re-encode (historical
  // double-encoding bug: the file would end up containing base64 text).
  const payload = readFileSync(src).toString("base64");
  const backupCmd = remoteExists ? `cp -p "$f" "$f.bak-${epoch}" && ` : "";
  execPod(
    tunnel,
    pod,
    `f="$HOME/${rel}"; mkdir -p "$(dirname "$f")" && ${backupCmd}base64 -d > "$f"`,
    payload,
  );
  return {
    ok: true,
    direction,
    convId: local.convId,
    lines: { local: local.lines, remote: remoteLines },
    backup: remoteExists ? `$HOME/${rel}.bak-${epoch}` : undefined,
    written: `$HOME/${rel}`,
  };
}
