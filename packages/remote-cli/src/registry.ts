/**
 * Live-session registry — the source of truth for `remote ls` / `remote
 * restore`, so they stop GUESSING sessions from filesystem mtimes.
 *
 * Entries land here from:
 *  - `remote run`        (source "run"  — local tmux sessions),
 *  - Claude Code hooks   (source "hook" — `remote enroll --hook claude-*`),
 *  - the restore scanner (source "scan" — legacy fallback),
 *  - the control-plane   (source "remote" — reconciled by the caller).
 *
 * The file is `<configDir>/registry.json`, written atomically (tmp + rename).
 * Every function takes an optional explicit path so tests never touch the real
 * config dir (default path honors REMOTE_CLI_CONFIG_HOME like config.ts).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";

import { getLayoutConfig, resolveConfigPath } from "./config.js";
import { listLocalSessions } from "./tmux.js";

export type RegistryTool = "claude" | "codex" | "agy";
export type RegistryKind = "local-tmux" | "local" | "remote";
export type RegistrySource = "run" | "hook" | "scan" | "remote";

/**
 * Delegated-job extension (P1 of cross-type agent delegation). A job IS a
 * RegistryEntry with `role: "job"` — same atomic-write, same liveness guards,
 * same `listLive`. These fields are OPTIONAL so every existing entry stays a
 * valid RegistryEntry (back-compat).
 */
export type RegistryRole = "job";
export type JobState = "pending" | "running" | "done" | "failed";

export type RegistryEntry = {
  /** Stable key: claude session uuid / codex rollout id / remoteId / tmux slug. */
  id: string;
  tool: RegistryTool;
  kind: RegistryKind;
  cwd: string;
  label?: string;
  /** Conversation id usable with the CLI's --resume. */
  convId?: string;
  /** Control-plane session id (kind "remote"). */
  remoteId?: string;
  /** Full tmux session name (kind "local-tmux"), e.g. `remote-surch`. */
  tmuxSession?: string;
  /** Local process id (kind "local"); liveness = process.kill(pid, 0). */
  pid?: number;
  enrolledAt: string;
  lastSeenAt: string;
  endedAt?: string;
  source: RegistrySource;
  /** "job" marks a delegated agent (see `delegate.ts`); absent = a session. */
  role?: RegistryRole;
  /** Lifecycle of a delegated job (role "job" only). */
  jobState?: JobState;
  /** Parent job/session id that delegated this job. */
  parent?: string;
  /** The task the delegated agent was primed with. */
  task?: string;
  /** h2a instance to address the `job.done` callback to (P3); the delegating
   * parent/master. Absent = no callback recipient (best-effort, no-op). */
  callbackTo?: string;
  /**
   * P4 — queued-launch spec. A job over the concurrency cap is enrolled
   * `pending` WITHOUT being launched; the conductor launches it later. These
   * fields carry everything `startJob` needs to launch it from the queue (they
   * are also set on an immediately-launched job, harmlessly). All optional so
   * every existing entry stays a valid RegistryEntry (back-compat).
   */
  /** Run the job in a Pod (the remote control-plane URL), else a local tmux session. */
  remoteTarget?: string;
  /** Run-once-exit headless mode (claude -p / codex exec). */
  headless?: boolean;
  /** The cwd the delegate was invoked from (origin for the per-job worktree/logs). */
  originCwd?: string;
  /** Explicit `--cwd` override (local; used as-is, no worktree). */
  explicitCwd?: string;
  /** Remaining spawn-depth budget this job may spend if it re-delegates (P4 depth clamp). */
  depthBudget?: number;
  /** Track workpackage id to mirror this job under (`track item new --parent`). */
  trackWp?: string;
};

export type EnrollInput = {
  id: string;
  tool: RegistryTool;
  kind: RegistryKind;
  cwd: string;
  source: RegistrySource;
  label?: string;
  convId?: string;
  remoteId?: string;
  tmuxSession?: string;
  pid?: number;
  role?: RegistryRole;
  jobState?: JobState;
  parent?: string;
  task?: string;
  callbackTo?: string;
  remoteTarget?: string;
  headless?: boolean;
  originCwd?: string;
  explicitCwd?: string;
  depthBudget?: number;
  trackWp?: string;
};

/** Injectable liveness probes (tests stay deterministic, no tmux/pid needed). */
export type LivenessOpts = {
  tmuxHasSession?: (name: string) => boolean;
  pidAlive?: (pid: number) => boolean;
  /** System boot time (ms epoch). A `kind:"local"` entry last seen before this
   * is dead — its process died in the reboot, so its PID must not be trusted
   * (PID reuse would falsely resurrect it). Injectable for tests. */
  bootTimeMs?: number;
  /** cmdline of a pid (to detect PID reuse after a crash). Injectable for tests. */
  processCmdline?: (pid: number) => string | undefined;
};

/** System boot time in ms epoch (now minus uptime). */
function defaultBootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

type RegistryOpts = LivenessOpts & { path?: string };

export function resolveRegistryPath(): string {
  return join(dirname(resolveConfigPath()), "registry.json");
}

export function loadRegistry(
  path: string = resolveRegistryPath(),
): RegistryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const entries = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(isRegistryEntry);
  } catch {
    // missing or corrupt file -> empty registry (it is rebuilt by enrolment)
    return [];
  }
}

function isRegistryEntry(raw: unknown): raw is RegistryEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    (e.tool === "claude" || e.tool === "codex" || e.tool === "agy") &&
    (e.kind === "local-tmux" || e.kind === "local" || e.kind === "remote") &&
    typeof e.cwd === "string" &&
    typeof e.enrolledAt === "string" &&
    typeof e.lastSeenAt === "string" &&
    (e.source === "run" ||
      e.source === "hook" ||
      e.source === "scan" ||
      e.source === "remote")
  );
}

/** Atomic write: tmp file in the same dir, then rename. */
function saveRegistry(entries: RegistryEntry[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Upsert by id. A re-enroll refreshes lastSeenAt, merges the new fields over
 * the stored ones, and REVIVES an ended entry (endedAt is dropped) — e.g. a
 * claude SessionStart on a resumed conversation.
 */
export function enroll(
  input: EnrollInput,
  path: string = resolveRegistryPath(),
): RegistryEntry {
  const entries = loadRegistry(path);
  const now = new Date().toISOString();
  const idx = entries.findIndex((e) => e.id === input.id);
  const prev = idx >= 0 ? entries[idx] : undefined;
  const entry: RegistryEntry = {
    id: input.id,
    tool: input.tool,
    kind: input.kind,
    cwd: input.cwd,
    source: input.source,
    enrolledAt: prev?.enrolledAt ?? now,
    lastSeenAt: now,
  };
  const label = input.label ?? prev?.label;
  if (label !== undefined) entry.label = label;
  const convId = input.convId ?? prev?.convId;
  if (convId !== undefined) entry.convId = convId;
  const remoteId = input.remoteId ?? prev?.remoteId;
  if (remoteId !== undefined) entry.remoteId = remoteId;
  const tmuxSession = input.tmuxSession ?? prev?.tmuxSession;
  if (tmuxSession !== undefined) entry.tmuxSession = tmuxSession;
  const pid = input.pid ?? prev?.pid;
  if (pid !== undefined) entry.pid = pid;
  const role = input.role ?? prev?.role;
  if (role !== undefined) entry.role = role;
  const jobState = input.jobState ?? prev?.jobState;
  if (jobState !== undefined) entry.jobState = jobState;
  const parent = input.parent ?? prev?.parent;
  if (parent !== undefined) entry.parent = parent;
  const task = input.task ?? prev?.task;
  if (task !== undefined) entry.task = task;
  const callbackTo = input.callbackTo ?? prev?.callbackTo;
  if (callbackTo !== undefined) entry.callbackTo = callbackTo;
  const remoteTarget = input.remoteTarget ?? prev?.remoteTarget;
  if (remoteTarget !== undefined) entry.remoteTarget = remoteTarget;
  const headless = input.headless ?? prev?.headless;
  if (headless !== undefined) entry.headless = headless;
  const originCwd = input.originCwd ?? prev?.originCwd;
  if (originCwd !== undefined) entry.originCwd = originCwd;
  const explicitCwd = input.explicitCwd ?? prev?.explicitCwd;
  if (explicitCwd !== undefined) entry.explicitCwd = explicitCwd;
  const depthBudget = input.depthBudget ?? prev?.depthBudget;
  if (depthBudget !== undefined) entry.depthBudget = depthBudget;
  const trackWp = input.trackWp ?? prev?.trackWp;
  if (trackWp !== undefined) entry.trackWp = trackWp;
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  saveRegistry(entries, path);
  return entry;
}

/**
 * The legal job lifecycle transitions (P1 keeps it linear; P4 adds the queue's
 * pending→running). A transition not listed here is rejected by `advanceJob`.
 * Pure, exported for tests.
 */
const JOB_TRANSITIONS: Readonly<Record<JobState, ReadonlyArray<JobState>>> = {
  pending: ["running", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/**
 * Move a job to `to`, persisting the new state (and stamping endedAt for the
 * terminal states). Returns the updated entry, or undefined when the id is
 * unknown / not a job / the transition is illegal. Reuses the atomic write.
 */
export function advanceJob(
  id: string,
  to: JobState,
  path: string = resolveRegistryPath(),
): RegistryEntry | undefined {
  const entries = loadRegistry(path);
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.role !== "job") return undefined;
  const from = entry.jobState ?? "pending";
  if (from !== to && !canTransitionJob(from, to)) return undefined;
  entry.jobState = to;
  entry.lastSeenAt = new Date().toISOString();
  if (to === "done" || to === "failed") entry.endedAt = entry.endedAt ?? entry.lastSeenAt;
  saveRegistry(entries, path);
  return entry;
}

/** Live job entries (role "job"), liveness reconciled like any other entry. */
export function listJobs(opts: RegistryOpts = {}): RegistryEntry[] {
  const path = opts.path ?? resolveRegistryPath();
  return loadRegistry(path).filter((e) => e.role === "job");
}

/** Refresh lastSeenAt. Returns false when the id is unknown. */
export function touchEntry(
  id: string,
  path: string = resolveRegistryPath(),
): boolean {
  const entries = loadRegistry(path);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.lastSeenAt = new Date().toISOString();
  saveRegistry(entries, path);
  return true;
}

/** Record the session's end. Returns false when the id is unknown. */
export function markEnded(
  id: string,
  path: string = resolveRegistryPath(),
): boolean {
  const entries = loadRegistry(path);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  const now = new Date().toISOString();
  entry.endedAt = now;
  entry.lastSeenAt = now;
  saveRegistry(entries, path);
  return true;
}

function defaultTmuxHasSession(name: string): boolean {
  try {
    // "=" prefix forces an exact session-name match (no prefix matching).
    return (
      spawnSync("tmux", ["has-session", "-t", `=${name}`], {
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The cmdline of a live pid (NUL-separated args joined with spaces), or
 * undefined when it can't be read. Used to detect PID REUSE: after a crash the
 * CLI's pid may be reassigned to an unrelated process, which `kill(pid,0)`
 * still reports as alive. /proc is Linux-only; elsewhere this returns undefined
 * and the caller stays conservative (treats the pid as still ours).
 */
function defaultProcessCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return undefined;
  }
}

/**
 * Does the process at `pid` look like the `tool` CLI? Reads its cmdline and
 * checks for the tool name. CONSERVATIVE on doubt: if the cmdline can't be read
 * (non-Linux, permissions) we return true (assume it is still ours) so the
 * single-writer guard never DROPS a real writer (which would risk two CLIs
 * corrupting one .jsonl). Only a readable cmdline that clearly isn't the tool
 * (a reused pid) returns false.
 */
function processIsTool(
  pid: number,
  tool: RegistryTool,
  read: (pid: number) => string | undefined,
): boolean {
  const cmd = read(pid);
  if (cmd === undefined) return true; // can't tell → assume still ours
  return cmd.includes(tool);
}

/**
 * Liveness:
 *  - local-tmux -> the tmux session exists,
 *  - local      -> pid alive (when recorded) AND not endedAt; without a pid
 *                  (hook-enrolled: the hook's parent pid is a throwaway shell)
 *                  we trust SessionEnd + prune,
 *  - remote     -> always "live" here; the CALLER reconciles against
 *                  listRemoteSessions (the registry cannot probe the cluster).
 */
export function isLive(e: RegistryEntry, opts: LivenessOpts = {}): boolean {
  if (e.endedAt) return false;
  if (e.kind === "local-tmux") {
    const has = opts.tmuxHasSession ?? defaultTmuxHasSession;
    return has(e.tmuxSession ?? `remote-${e.id}`);
  }
  if (e.kind === "local") {
    // A process cannot survive a reboot: an entry last seen BEFORE the machine
    // booted is dead, whether or not it carries a pid.
    const bootMs = opts.bootTimeMs ?? defaultBootTimeMs();
    if (Date.parse(e.lastSeenAt) < bootMs) return false;
    // No pid (the claude SessionStart hook can't reliably capture claude's pid):
    // unverifiable. Treat as live here, but convOwners demotes a no-pid local
    // entry to a SUSPECT (warn), not a hard block — so a stale hook entry left
    // by a crash never refuses a relaunch.
    if (e.pid === undefined) return true;
    if (!(opts.pidAlive ?? defaultPidAlive)(e.pid)) return false;
    // pid alive — but is it STILL our CLI? After a crash the dead CLI's pid can
    // be reassigned to an unrelated process that kill(pid,0) reports as alive;
    // verify the process identity to avoid a false live-writer.
    return processIsTool(
      e.pid,
      e.tool,
      opts.processCmdline ?? defaultProcessCmdline,
    );
  }
  return true;
}

/** Entries considered live right now (see isLive for the per-kind rules). */
export function listLive(opts: RegistryOpts = {}): RegistryEntry[] {
  const path = opts.path ?? resolveRegistryPath();
  return loadRegistry(path).filter((e) => isLive(e, opts));
}

/**
 * Drop DEAD entries whose last activity (endedAt, else lastSeenAt) is older
 * than maxAgeHours. Live entries always stay; recently-dead ones stay too so
 * `restore` can still resume them after a reboot via the scan fallback.
 * Returns the number of removed entries.
 */
export function prune(maxAgeHours: number, opts: RegistryOpts = {}): number {
  const path = opts.path ?? resolveRegistryPath();
  const entries = loadRegistry(path);
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const kept = entries.filter((e) => {
    if (isLive(e, opts)) return true;
    const last = Date.parse(e.endedAt ?? e.lastSeenAt);
    return Number.isFinite(last) && last >= cutoff;
  });
  if (kept.length === entries.length) return 0;
  saveRegistry(kept, path);
  return entries.length - kept.length;
}

/** Map a CLI profile name to a registry tool (undefined for shell/opencode/…). */
export function coerceRegistryTool(profile: string): RegistryTool | undefined {
  switch (profile) {
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "agy":
    case "antigravity":
      return "agy";
    default:
      return undefined;
  }
}

/**
 * Auto-enrolment after `remote run` started a local tmux session. Best-effort
 * plumbing: never throws (a registry hiccup must not break the run).
 */
export function enrollFromRun(args: {
  profile: string;
  slug: string;
  tmuxSession: string;
  cwd: string;
  convId?: string;
}): void {
  const tool = coerceRegistryTool(args.profile);
  if (!tool) return; // shell/opencode/… sessions stay tmux-only
  try {
    enroll({
      id: args.slug,
      tool,
      kind: "local-tmux",
      cwd: args.cwd,
      source: "run",
      label: args.slug,
      tmuxSession: args.tmuxSession,
      ...(args.convId !== undefined ? { convId: args.convId } : {}),
    });
  } catch {
    // best-effort: the tmux session is up regardless
  }
}

export type LocalLsRow = {
  slug: string;
  profile: string;
  state: "attached" | "detached" | "live";
  path: string;
  /** "registry" = enrolled (reliable cwd/convId); "guess" = tmux-only. */
  badge: "registry" | "guess";
};

/**
 * LOCAL rows for `remote ls`: live tmux sessions joined with the registry
 * ([registry] vs [guess] badge), plus live registry-only sessions (e.g. a
 * hook-enrolled claude running in a plain terminal). Dead registry entries are
 * pruned on the way (layout maxAgeHours).
 */
export function listLocalForLs(opts: RegistryOpts = {}): LocalLsRow[] {
  const path = opts.path ?? resolveRegistryPath();
  try {
    prune(getLayoutConfig().maxAgeHours, { ...opts, path });
  } catch {
    // a config/registry hiccup must not break `remote ls`
  }
  const live = listLive({ ...opts, path });
  const rows: LocalLsRow[] = [];
  const matched = new Set<string>();
  for (const s of listLocalSessions()) {
    const entry = live.find(
      (e) => e.tmuxSession === s.name || e.id === s.slug,
    );
    if (entry) matched.add(entry.id);
    rows.push({
      slug: s.slug,
      profile: s.profile,
      state: s.attached ? "attached" : "detached",
      path: s.path,
      badge: entry ? "registry" : "guess",
    });
  }
  for (const e of live) {
    if (e.kind !== "local" || matched.has(e.id)) continue;
    rows.push({
      slug: e.label ?? e.id.slice(0, 12),
      profile: e.tool,
      state: "live",
      path: e.cwd,
      badge: "registry",
    });
  }
  return rows;
}
