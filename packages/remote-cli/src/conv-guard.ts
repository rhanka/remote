/**
 * Single-writer guard per conversation (WP5).
 *
 * A claude/codex conversation is one append-only .jsonl — TWO CLIs resuming
 * the same convId at once interleave their appends and corrupt it (the user's
 * critical asset). Before `remote run -r <conv>` / `remote migrate forward
 * -r <conv>` start a new writer, convOwners() lists every LIVE writer already
 * holding that conversation:
 *
 *  (a) live local registry entries (registry.ts) with the same convId —
 *      another tmux session or a hook-enrolled plain-terminal CLI,
 *  (b) live remote sessions whose cliSessionId (reported by the session-agent)
 *      matches; a remote session WITHOUT a cliSessionId but running on the
 *      same workspacePath is flagged as a SUSPECT (warning, not refusal).
 *
 * guardConvWriters() is the shared wiring: prints the warnings/refusal and
 * tells the caller whether to proceed (--force overrides, loudly).
 */

import { listLive, type LivenessOpts, type RegistryEntry } from "./registry.js";

export type ConvOwnerWhere = "local-tmux" | "local" | "remote";

export type ConvOwner = {
  where: ConvOwnerWhere;
  /** Short handle: tmux slug, registry label, or remote session id/name. */
  label: string;
  /** Human sentence: what holds the conversation and how to release it. */
  detail: string;
  /** true = cwd-only heuristic (no cliSessionId) — warn, do not refuse. */
  suspect?: boolean;
};

/** The subset of listRemoteSessions() rows the guard needs. */
export type RemoteSessionLite = {
  id: string;
  displayName?: string;
  cliSessionId?: string;
  workspacePath?: string;
};

export type ConvOwnersOpts = LivenessOpts & {
  /** Registry file override (tests). */
  registryPath?: string;
  /** Registry entry id to ignore (the entry the caller is creating/reviving). */
  excludeId?: string;
  /** Live remote sessions, already fetched by the caller (omit = no remote check). */
  remoteSessions?: ReadonlyArray<RemoteSessionLite>;
  /** Local project path — enables the workspacePath "suspect" heuristic. */
  cwd?: string;
};

function ownerFromEntry(e: RegistryEntry): ConvOwner {
  if (e.kind === "local-tmux") {
    const slug = e.label ?? e.id;
    return {
      where: "local-tmux",
      label: slug,
      detail: `local tmux session ${e.tmuxSession ?? `remote-${e.id}`} (${e.tool}, cwd ${e.cwd}) — stop it first: remote stop ${slug}`,
    };
  }
  return {
    where: "local",
    label: e.label ?? e.id.slice(0, 12),
    detail: `local ${e.tool} process${e.pid !== undefined ? ` (pid ${e.pid})` : ""} in ${e.cwd} — exit that CLI first`,
    // A no-pid hook entry is UNVERIFIABLE (no process to probe): a crash leaves
    // it "live" forever. Demote it to a SUSPECT (warn) so it never hard-blocks
    // a relaunch; only verifiable writers (live tmux / pid+cmdline / remote)
    // refuse. A pid'd entry that reached here passed the liveness check → hard.
    ...(e.pid === undefined ? { suspect: true } : {}),
  };
}

/**
 * Every live writer currently holding convId. Entries with suspect=true are
 * heuristic matches (same workspacePath, no cliSessionId) — warning-grade only.
 */
export function convOwners(
  convId: string,
  opts: ConvOwnersOpts = {},
): ConvOwner[] {
  const owners: ConvOwner[] = [];
  const live = listLive({
    ...(opts.tmuxHasSession ? { tmuxHasSession: opts.tmuxHasSession } : {}),
    ...(opts.pidAlive ? { pidAlive: opts.pidAlive } : {}),
    ...(opts.bootTimeMs !== undefined ? { bootTimeMs: opts.bootTimeMs } : {}),
    ...(opts.processCmdline ? { processCmdline: opts.processCmdline } : {}),
    ...(opts.registryPath ? { path: opts.registryPath } : {}),
  });
  for (const e of live) {
    if (e.convId !== convId) continue;
    if (opts.excludeId !== undefined && e.id === opts.excludeId) continue;
    // kind "remote" registry entries can be stale (the registry cannot probe
    // the cluster) — opts.remoteSessions, fetched live, is authoritative.
    if (e.kind === "remote") continue;
    owners.push(ownerFromEntry(e));
  }
  for (const s of opts.remoteSessions ?? []) {
    if (s.cliSessionId === convId) {
      owners.push({
        where: "remote",
        label: s.displayName ?? s.id,
        detail: `remote session ${s.id}${s.workspacePath ? ` (${s.workspacePath})` : ""} is on this conversation — stop it first: remote stop ${s.id}`,
      });
    } else if (
      s.cliSessionId === undefined &&
      opts.cwd !== undefined &&
      s.workspacePath === opts.cwd
    ) {
      owners.push({
        where: "remote",
        label: s.displayName ?? s.id,
        detail: `remote session ${s.id} runs on the same path (${s.workspacePath}) and MAY hold this conversation (no cliSessionId reported yet)`,
        suspect: true,
      });
    }
  }
  return owners;
}

/** Multi-line refusal message for hard (non-suspect) conflicts. */
export function formatConvConflict(
  convId: string,
  owners: ReadonlyArray<ConvOwner>,
): string {
  const lines = owners.map((o) => `  - [${o.where}] ${o.label}: ${o.detail}`);
  return (
    `[remote] conversation ${convId} already has a live writer:\n` +
    `${lines.join("\n")}\n` +
    `[remote] two CLIs appending to the same conversation .jsonl corrupt it — ` +
    `stop the other writer first, or pass --force to take over anyway.\n`
  );
}

export type GuardConvWritersArgs = LivenessOpts & {
  convId: string;
  /** Local project path (suspect heuristic for remote sessions). */
  cwd: string;
  /** Override the refusal (still warns). */
  force?: boolean;
  /**
   * Best-effort fetch of live remote sessions; a throw (no remote configured,
   * tunnel down) silently degrades the guard to local-registry-only.
   */
  fetchRemoteSessions?: () => Promise<ReadonlyArray<RemoteSessionLite>>;
  /** Registry file override (tests). */
  registryPath?: string;
};

/**
 * Shared wiring for `remote run -r` / `remote migrate forward -r`. Prints
 * warnings (suspects, --force override) and the refusal itself; returns
 * true when the caller may start the new writer.
 */
export async function guardConvWriters(
  args: GuardConvWritersArgs,
): Promise<boolean> {
  let remoteSessions: ReadonlyArray<RemoteSessionLite> | undefined;
  if (args.fetchRemoteSessions) {
    try {
      remoteSessions = await args.fetchRemoteSessions();
    } catch {
      // remote unreachable — degrade to the local registry (best-effort)
    }
  }
  const owners = convOwners(args.convId, {
    cwd: args.cwd,
    ...(remoteSessions !== undefined ? { remoteSessions } : {}),
    ...(args.registryPath ? { registryPath: args.registryPath } : {}),
    ...(args.tmuxHasSession ? { tmuxHasSession: args.tmuxHasSession } : {}),
    ...(args.pidAlive ? { pidAlive: args.pidAlive } : {}),
    ...(args.bootTimeMs !== undefined ? { bootTimeMs: args.bootTimeMs } : {}),
    ...(args.processCmdline ? { processCmdline: args.processCmdline } : {}),
  });
  const hard = owners.filter((o) => !o.suspect);
  for (const s of owners.filter((o) => o.suspect)) {
    process.stderr.write(
      `[remote] warning: ${s.detail} — make sure it is not resuming conversation ${args.convId}.\n`,
    );
  }
  if (hard.length === 0) return true;
  if (args.force) {
    process.stderr.write(
      `[remote] warning: --force — taking over conversation ${args.convId} despite ${hard.length} live writer(s); concurrent writes WILL corrupt the .jsonl.\n`,
    );
    return true;
  }
  process.stderr.write(formatConvConflict(args.convId, hard));
  return false;
}
