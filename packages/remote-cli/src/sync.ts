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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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

/** Like execPod but never throws — returns {stdout, status}. */
export function execPodRaw(
  tunnel: TunnelConfig,
  pod: string,
  script: string,
  input?: string,
): { stdout: string; status: number } {
  const args = ["-n", tunnel.namespace, "exec"];
  if (input !== undefined) args.push("-i");
  args.push(pod, "-c", "session-agent", "--", "bash", "-lc", script);
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const r = spawnSync("kubectl", args, {
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  return { stdout: r.stdout ?? "", status: r.status ?? 1 };
}

/** Non-empty line count of a local file (same convention as convsync). */
function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Phase B1 — incremental conv sync state
// ---------------------------------------------------------------------------

type ConvSyncState = {
  offset: number;
  prefixHash: string;
  generation: number;
  lastAckedToken?: number;
  updatedAt: string;
};

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function convSyncStatePath(convId: string, home: string = homedir()): string {
  return join(home, ".remote", "conv-sync-state", convId + ".json");
}

export function readConvSyncState(
  convId: string,
  home?: string,
): ConvSyncState | undefined {
  const p = convSyncStatePath(convId, home);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ConvSyncState;
  } catch {
    return undefined;
  }
}

export function writeConvSyncState(
  state: ConvSyncState,
  convId: string,
  home?: string,
): void {
  const p = convSyncStatePath(convId, home);
  mkdirSync(dirname(p), { recursive: true });
  // Atomic write: temp file in the same dir as target so rename is same-fs.
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
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
      incremental: boolean;
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
    // --- Incremental path (Phase B1) - pull ---
    const pullState = readConvSyncState(remote.convId);
    if (pullState && pullState.offset > 0) {
      if (existsSync(dst)) {
        const localBuf = readFileSync(dst);
        if (localBuf.length >= pullState.offset) {
          const localPrefixHash = sha256Bytes(localBuf.slice(0, pullState.offset));
          if (localPrefixHash === pullState.prefixHash) {
            // Fetch only the tail from pod
            const deltaB64Result = execPodRaw(
              tunnel,
              pod,
              `f="$HOME/${rel}"; ` +
                `actual=$(head -c ${pullState.offset} "$f" 2>/dev/null | sha256sum | cut -d' ' -f1); ` +
                `if [ "$actual" = "${pullState.prefixHash}" ]; then tail -c +${pullState.offset + 1} "$f" | base64 | tr -d '\\n'; else exit 42; fi`,
            );
            if (deltaB64Result.status === 0 && deltaB64Result.stdout.trim()) {
              const delta = Buffer.from(deltaB64Result.stdout.trim(), "base64");
              const newBuf = Buffer.concat([localBuf, delta]);
              writeFileSync(dst, newBuf);
              const newHash = sha256Bytes(newBuf);
              writeConvSyncState(
                {
                  offset: newBuf.length,
                  prefixHash: newHash,
                  generation: pullState.generation + 1,
                  updatedAt: new Date().toISOString(),
                },
                remote.convId,
              );
              return {
                ok: true,
                direction,
                convId: remote.convId,
                lines: { local: localLines, remote: remote.lines },
                backup: undefined,
                written: dst,
                incremental: true,
              };
            }
          }
        }
      }
    }
    // --- End incremental pull path — fallback to whole-file ---
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
    // Persist sync state for future incremental syncs.
    writeConvSyncState(
      {
        offset: buf.length,
        prefixHash: sha256Bytes(buf),
        generation: (readConvSyncState(remote.convId)?.generation ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      },
      remote.convId,
    );
    return {
      ok: true,
      direction,
      convId: remote.convId,
      lines: { local: localLines, remote: remote.lines },
      backup,
      written: dst,
      incremental: false,
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
  // --- Incremental path (Phase B1) ---
  const state = readConvSyncState(local.convId);
  if (state && state.offset > 0 && state.offset <= local.bytes) {
    const fullBuf = readFileSync(src);
    const localPrefixHash = sha256Bytes(fullBuf.slice(0, state.offset));
    if (localPrefixHash === state.prefixHash) {
      // Local prefix is intact. Check pod prefix AND append atomically (anti-TOCTOU).
      const delta = fullBuf.slice(state.offset);
      const deltaB64 = delta.toString("base64");
      const result = execPodRaw(
        tunnel,
        pod,
        // head -c reads <offset> bytes, sha256sum -c checks against expected hash.
        // If mismatch → exit 42 (not 1, to distinguish from other errors).
        // If match → base64 -d appends the delta.
        `f="$HOME/${rel}"; ` +
          `actual=$(head -c ${state.offset} "$f" 2>/dev/null | sha256sum | cut -d' ' -f1); ` +
          `if [ "$actual" = "${state.prefixHash}" ]; then base64 -d >> "$f"; else exit 42; fi`,
        deltaB64,
      );
      if (result.status === 0) {
        const newHash = sha256Bytes(fullBuf);
        writeConvSyncState(
          {
            offset: fullBuf.length,
            prefixHash: newHash,
            generation: state.generation + 1,
            updatedAt: new Date().toISOString(),
          },
          local.convId,
        );
        return {
          ok: true,
          direction,
          convId: local.convId,
          lines: { local: local.lines, remote: remoteLines },
          backup: undefined,
          written: `$HOME/${rel}`,
          incremental: true,
        };
      }
      // rc=42 = prefix mismatch on pod side → fallthrough to whole-file
      // rc=anything else → also fallthrough (don't throw; let whole-file handle it)
    }
  }
  // --- End incremental path — fallback to whole-file below ---
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
  // Persist sync state for future incremental syncs.
  const fullContent = readFileSync(src);
  writeConvSyncState(
    {
      offset: fullContent.length,
      prefixHash: sha256Bytes(fullContent),
      generation: (readConvSyncState(local.convId)?.generation ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    },
    local.convId,
  );
  return {
    ok: true,
    direction,
    convId: local.convId,
    lines: { local: local.lines, remote: remoteLines },
    backup: remoteExists ? `$HOME/${rel}.bak-${epoch}` : undefined,
    written: `$HOME/${rel}`,
    incremental: false,
  };
}
