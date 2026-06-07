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
import { dirname, join } from "node:path";

import { getLayoutConfig, resolveConfigPath } from "./config.js";
import { listLocalSessions } from "./tmux.js";

export type RegistryTool = "claude" | "codex" | "agy";
export type RegistryKind = "local-tmux" | "local" | "remote";
export type RegistrySource = "run" | "hook" | "scan" | "remote";

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
};

/** Injectable liveness probes (tests stay deterministic, no tmux/pid needed). */
export type LivenessOpts = {
  tmuxHasSession?: (name: string) => boolean;
  pidAlive?: (pid: number) => boolean;
};

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
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  saveRegistry(entries, path);
  return entry;
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
    if (e.pid !== undefined) return (opts.pidAlive ?? defaultPidAlive)(e.pid);
    return true;
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
