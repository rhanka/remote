#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  attach,
  createRemoteSession,
  getRemoteSession,
  listRemoteSessions,
  refreshRemoteSession,
  sessionTerminalHealth,
  stopRemoteSession,
} from "./attach.js";
import {
  clearDefaultRemote,
  getDefaultRemote,
  getDefaultTarget,
  getDefaultTools,
  getH2aConfig,
  getJobMaxAgeHours,
  getMaxConcurrent,
  getTunnel,
  setDefaultRemote,
  setDefaultTarget,
  setDefaultTools,
  setToken,
  setTunnel,
  type TunnelConfig,
} from "./config.js";
import { ensureConnected, stopTunnel } from "./tunnel.js";
import {
  detectToolAuth,
  KNOWN_TOOLS,
  partitionTools,
} from "./auth-tools.js";
import { transmittedSecrets, secretsSummary } from "./secrets.js";
import { localConvStat, remoteConvStat, alignment } from "./convsync.js";
import {
  gitAlignment,
  localAncestry,
  localGitStat,
  remoteGitStat,
} from "./gitdiff.js";
import { syncConversation, type SyncDirection } from "./sync.js";
import {
  attachLocalSession,
  attachPodTmux,
  capturePane,
  conductorRunning,
  fanoutLabels,
  findLocalSession,
  killLocalSession,
  listLocalSessions,
  localSessionIdle,
  localSessionName,
  relaunchInSession,
  startH2aWindow,
  startHeadlessSession,
  startLocalSession,
  tmuxAvailable,
} from "./tmux.js";
import { planRelaunch } from "./relaunch.js";
import {
  readLastLayout,
  restore as restoreLayout,
  type RestoreOptions,
} from "./restore.js";
import { getLayoutConfig } from "./config.js";
import {
  advanceJob,
  enroll,
  enrollFromRun,
  isLive,
  listJobs,
  listLocalForLs,
  loadRegistry,
  tryClaimSlot,
  type RegistryEntry,
} from "./registry.js";
import {
  assertSafeName,
  buildDelegateArgs,
  buildJobRows,
  buildRemoteDelegate,
  canDelegateAtDepth,
  childDepthEnvValue,
  clampDepth,
  clampRemoteDepthBudget,
  conductorAdvisory,
  DEFAULT_MAX_CONCURRENT,
  DEPTH_ENV,
  inheritedDepthBudget,
  isDelegateType,
  JOB_ID_ENV,
  jobDir,
  planNextStarts,
  readJobResult,
  reconcileRemoteJobs,
  renderJobsTable,
  resolveJobCwd,
  runTrackMirror,
  sweepStaleJobs,
  trackItemNewArgs,
  trackItemRealizeArgs,
  type DelegateType,
} from "./delegate.js";
import {
  DEFAULT_FANOUT_MAX,
  mapWithConcurrency,
  planRemoteFanout,
  type RemoteFanoutMember,
} from "./fanout.js";
import {
  authenticateJobEnvelopes,
  buildDecisionReply,
  dropEnvelope,
  emitJobDone,
  envelopeFileName,
  isAwaitingDecision,
  jobInstance,
  parentInstance,
  pendingDecisions,
  readInboxEnvelopes,
  renderPendingDecisions,
  repliedDecisionJobIds,
  type ExpectedInstanceResolver,
} from "./h2a-jobs.js";
import {
  buildConductorTask,
  computeDurableWorkspaceId,
  normalizeRootCommits,
  detectAvailableHosts,
  freshestLaunchEnvelope,
  h2aReportsLiveConductor,
  markLaunchEnvelopeProcessed,
  readLastLaunchAt,
  readLaunchEnvelopes,
  recordLaunchAt,
  selectHost,
  shouldLaunch,
  type ConductorLaunchRequest,
} from "./conductor-launch.js";
import { guardConvWriters } from "./conv-guard.js";
import {
  handleClaudeHook,
  installClaudeHooks,
  manualEnroll,
  readStdin,
} from "./enroll.js";
import { softRefreshSession } from "./soft-refresh.js";
import { forwardSessionPort } from "./forward.js";
import { buildBrowserOpenPlan } from "./browser.js";
import {
  inspectProfileAuth,
  type AuthDiagnosticsStatus,
} from "./auth-diagnostics.js";
import { AuthRefreshError, ensureProfileAuthFresh } from "./auth-refresh.js";
import {
  AuthBundleMissingError,
  assertRequiredAuthBundle,
  collectProfileAuth,
} from "./auth-bundle.js";
import { coerceCliProfileName, isCliProfile, resolveProfile, resumeArgsFor } from "./profiles.js";
import { getLoginCommand, runInteractiveLogin } from "./auth-login.js";
import {
  buildWorkspaceArchive,
  uploadWorkspaceArchive,
} from "./workspace-sync.js";
import {
  acquireWorkspaceLock,
  createWorkspace,
  deleteWorkspace,
  downloadWorkspaceExport,
  listWorkspaces,
  lockHolderId,
  readBaseSnapshot,
  readWorkspaceMarker,
  releaseWorkspaceLock,
  writeBaseSnapshot,
  writeWorkspaceMarker,
} from "./workspace.js";
import { mergeWorkspaceArchive } from "./workspace-merge.js";
import {
  restoreSessionsToLocal,
  type OnConflict,
} from "./session-restore.js";
import { run } from "./run.js";
import { pluginAdd, pluginAddInstaller, pluginLs, pluginSync } from "./plugin.js";
import { syncSkills } from "./skills-sync.js";
import { smokeRemoteProfile } from "./smoke.js";
import { migrateForward, migrateBack } from "./migrate.js";
import {
  listMigrationCandidates,
  humanSize,
  humanAge,
} from "./migrate-candidates.js";
import { createInterface } from "node:readline";

import { CLI_PROFILES, type CliProfile } from "@sentropic/remote-protocol";

export const packageName = "@sentropic/remote-cli";

export { run } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";
export {
  attach,
  createRemoteSession,
  getRemoteSession,
  listRemoteSessions,
  refreshRemoteSession,
  stopRemoteSession,
} from "./attach.js";
export type { AttachOptions, AttachResult } from "./attach.js";
export { inspectProfileAuth } from "./auth-diagnostics.js";
export type {
  AuthDiagnosticsResult,
  AuthDiagnosticsStatus,
} from "./auth-diagnostics.js";
export { AuthRefreshError, ensureProfileAuthFresh } from "./auth-refresh.js";
export {
  AuthBundleMissingError,
  assertRequiredAuthBundle,
  collectProfileAuth,
} from "./auth-bundle.js";
export type { AuthBundle } from "./auth-bundle.js";
export {
  resolveProfile,
  coerceCliProfileName,
  isCliProfile,
  withResume,
  type ProfileConfig,
} from "./profiles.js";
export { smokeRemoteProfile } from "./smoke.js";
export type {
  SmokeRemoteProfileOptions,
  SmokeRemoteProfileResult,
} from "./smoke.js";
export { migrateForward, migrateBack } from "./migrate.js";
export type {
  MigrateForwardOptions,
  MigrateForwardResult,
  MigrateBackOptions,
  MigrateBackResult,
} from "./migrate.js";
export {
  pluginAdd,
  pluginAddInstaller,
  pluginLs,
  pluginSync,
  parseMcpSpec,
  parseMcpSpecs,
  detectMcpBins,
  upsertCodexMcpServer,
  mergeClaudeMcpServers,
  buildPodSyncScript,
} from "./plugin.js";

type ProfileOpts = {
  resume?: string | true;
  port?: number;
  remote?: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  auth?: boolean;
  authRefresh?: boolean;
  sync?: boolean;
  workspaceId?: string;
  /** WP6 — fan out N concurrent REMOTE sessions (each on its own RWX subPath). */
  count?: number;
  /** Base label for the fan-out fleet names (default: cwd basename). */
  name?: string;
};

type ProfileCliOpts = ProfileOpts & {
  local?: boolean;
  workspace?: boolean;
};

type AuthDiagnosticOpts = {
  authRefresh?: boolean;
};

type SmokeOpts = {
  remote?: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  timeout?: number;
  auth?: boolean;
  authRefresh?: boolean;
};

type RefreshOpts = {
  profile?: string;
  auth?: boolean;
  authRefresh?: boolean;
};

function describeAuthStatus(status: AuthDiagnosticsStatus): string {
  if (status.checked) return `ok: ${status.command}`;
  return `skipped: ${status.reason}`;
}

function resumeStartupArgs(profileName: string, resume: string | true): string[] {
  if (!isCliProfile(profileName)) return [];
  return resumeArgsFor(resolveProfile(profileName), resume);
}

/**
 * WP6 — REMOTE fan-out: create N concurrent remote sessions, each on its OWN
 * workspace subPath of the ONE shared RWX volume (each member does its own
 * `createWorkspace` → distinct server-assigned workspaceId → distinct subPath;
 * NEVER one PVC per session). The same credential bundle is reused across the
 * fleet (one auth). Creation is bounded-concurrent (cap = the fleet size,
 * itself <= DEFAULT_FANOUT_MAX). NEVER auto-attaches — a fleet has no single
 * terminal to take over; prints a summary table and the per-session attach
 * hints, mirroring the LOCAL `remote run --count` contract. Reconcile/cleanup
 * of dead members reuses the existing `remote ls`/`jobs` reconciliation against
 * `listRemoteSessions` (a dead Pod simply drops off the live list). Returns the
 * created (id,name) pairs; throws only on a setup error before fan-out.
 */
async function startRemoteFanout(
  remote: string,
  profileName: string,
  members: ReadonlyArray<RemoteFanoutMember>,
  spec: {
    target: ProfileOpts["target"];
    startupArgs: readonly string[];
    credentials?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const target = spec.target ?? getDefaultTarget();
  // Bound the creation burst by the fleet size (already <= the fan-out cap).
  const results = await mapWithConcurrency(
    members,
    members.length,
    async (member) => {
      // Each member gets its OWN workspace → its OWN subPath on the shared RWX
      // volume (server assigns the workspaceId). This is the single-session
      // wiring repeated N times, never a shared tree.
      const ws = await createWorkspace(remote, { displayName: member.workspaceName });
      const session = await createRemoteSession(remote, {
        profile: profileName,
        target,
        workspaceId: ws.id,
        displayName: member.name,
        ...(spec.startupArgs.length > 0 ? { startupArgs: spec.startupArgs } : {}),
        ...(spec.credentials ? { credentials: spec.credentials } : {}),
      });
      return { name: member.name, sessionId: session.id, workspaceId: ws.id };
    },
  );
  const ok = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  const failed = members.filter((_m, i) => results[i]!.status === "rejected");
  // Summary table (reuses the same aligned plain-text style as `jobs ls`).
  const rows = results.map((r, i) => {
    const member = members[i]!;
    if (r.status === "fulfilled") {
      return [member.name, r.value.sessionId, r.value.workspaceId, "created"].join("\t");
    }
    return [member.name, "-", "-", `FAILED: ${(r.reason as Error).message}`].join("\t");
  });
  process.stdout.write(
    `NAME\tSESSION\tWORKSPACE\tSTATUS\n${rows.join("\n")}\n`,
  );
  process.stderr.write(
    `[remote] ${ok.length}/${members.length} remote ${profileName} sessions created on ${remote} (shared RWX, subPath per session)\n`,
  );
  if (ok.length > 0) {
    process.stderr.write(
      `[remote] attach one with: remote attach <session>   (list: remote ls)\n`,
    );
  }
  if (failed.length > 0) {
    process.stderr.write(
      `[remote] ${failed.length} session(s) failed to create — re-run --count for the shortfall, or check the control-plane\n`,
    );
    process.exitCode = 1;
  }
}

async function runProfile(
  profileName: string,
  opts: ProfileOpts,
  commandArgs: readonly string[] = [],
): Promise<void> {
  // WP6 — validate --count up front (a malformed value must fail loudly, not
  // silently fall through to a single session).
  if (opts.count !== undefined) {
    if (!Number.isInteger(opts.count) || opts.count < 1) {
      throw new Error("--count must be a whole number >= 1");
    }
    if (opts.count > 1 && !opts.remote) {
      throw new Error(
        "--count > 1 is a REMOTE fan-out — it needs a configured remote (use `remote run --count` for LOCAL tmux fan-out)",
      );
    }
  }
  if (opts.remote) {
    await ensureConnected(opts.remote);
    let credentials: Readonly<Record<string, string>> | undefined;
    if (opts.auth !== false && isCliProfile(profileName)) {
      if (opts.authRefresh !== false) {
        const result = await ensureProfileAuthFresh(profileName);
        if (result.checked) {
          process.stderr.write(`[remote] auth status ok: ${result.command}\n`);
        }
      }
      const bundle = await collectProfileAuth(profileName);
      assertRequiredAuthBundle(profileName, bundle);
      if (Object.keys(bundle).length > 0) credentials = bundle;
    }
    const resumeArgs =
      opts.resume !== undefined
        ? resumeStartupArgs(profileName, opts.resume)
        : [];
    const startupArgs = [...resumeArgs, ...commandArgs];

    // WP6 — REMOTE fan-out: --count N spawns N concurrent remote sessions, each
    // on its OWN workspace subPath of the shared RWX volume. count<=1 falls
    // through to the single-session path below unchanged.
    const count = opts.count ?? 1;
    if (count > 1) {
      // A fan-out is N FRESH conversations on N DISTINCT workspaces — resuming
      // one conv into N would corrupt it, --sync seeds ONE cwd into ONE
      // workspace (ambiguous for N), and an explicit --workspace pins ONE
      // subPath (collides for N). Mirror the LOCAL --count guards.
      if (opts.resume !== undefined) {
        throw new Error(
          "--count > 1 cannot combine with -r/--resume (each fanned session is a fresh conversation on its own workspace)",
        );
      }
      if (opts.sync) {
        throw new Error(
          "--count > 1 cannot combine with --sync (one cwd cannot seed N distinct remote workspaces unambiguously)",
        );
      }
      if (opts.workspaceId) {
        throw new Error(
          "--count > 1 cannot reuse a single mapped workspace (each session needs its OWN subPath); run from an unmapped dir or use --no-workspace",
        );
      }
      const base = opts.name ?? basename(process.cwd());
      const members = planRemoteFanout({ base, count, max: DEFAULT_FANOUT_MAX });
      await startRemoteFanout(opts.remote, profileName, members, {
        target: opts.target,
        startupArgs,
        ...(credentials ? { credentials } : {}),
      });
      return;
    }

    let archive: Buffer | undefined;
    if (opts.sync) {
      process.stderr.write(`[remote] packing ${process.cwd()} (respecting .gitignore)\n`);
      archive = await buildWorkspaceArchive(process.cwd());
      process.stderr.write(
        `[remote] workspace archive: ${(archive.byteLength / 1024).toFixed(0)} KiB\n`,
      );
    }
    const session = await createRemoteSession(opts.remote, {
      profile: profileName,
      target: opts.target ?? getDefaultTarget(),
      ...(startupArgs.length > 0 ? { startupArgs } : {}),
      ...(credentials ? { credentials } : {}),
      ...(opts.sync ? { workspaceSync: true } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    if (archive) {
      await uploadWorkspaceArchive(opts.remote, session.id, archive);
      process.stderr.write(
        `[remote] uploaded workspace to ${opts.remote}/sessions/${session.id}/workspace\n`,
      );
    }
    if (credentials) {
      process.stderr.write(
        `[remote] sending ${profileName} creds to ${opts.remote}: ${Object.keys(credentials).join(", ")}\n`,
      );
      process.stderr.write(
        `[remote] (use --no-auth to start without credentials)\n`,
      );
    }
    process.stderr.write(
      `[remote] attached to ${opts.remote}/sessions/${session.id}\n`,
    );
    const attachSession = await attach({
      baseUrl: opts.remote,
      sessionId: session.id,
    });
    await attachSession.finished;
    return;
  }
  const runOptions: import("./run.js").RunOptions = {
    profile: profileName,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(commandArgs.length > 0 ? { startupArgs: commandArgs } : {}),
  };
  const result = await run(runOptions);
  process.stderr.write(
    `[remote] session ${result.sessionId} attach at http://127.0.0.1:${result.port}\n`,
  );
  const { exitCode } = await result.exit;
  process.exitCode = exitCode;
}

async function refreshProfileSession(
  baseUrl: string,
  sessionId: string,
  opts: RefreshOpts,
): Promise<void> {
  const remoteProfile = (await getRemoteSession(baseUrl, sessionId)).session
    .profile;
  const requestedProfile = opts.profile ?? remoteProfile;
  if (opts.profile && coerceCliProfileName(opts.profile) !== coerceCliProfileName(remoteProfile)) {
    process.stderr.write(
      `[remote] warning: --profile ${opts.profile} does not match the session profile ${remoteProfile}; bundling ${opts.profile} credentials anyway\n`,
    );
  }
  const profileName = coerceCliProfileName(requestedProfile);
  if (!profileName) {
    throw new Error(
      `Unknown profile "${requestedProfile}". Known: codex, claude, agy, opencode, shell (aliases: claude-code, antigravity)`,
    );
  }

  let credentials: Readonly<Record<string, string>> | undefined;
  if (opts.auth !== false) {
    if (opts.authRefresh !== false) {
      const result = await ensureProfileAuthFresh(profileName);
      if (result.checked) {
        process.stderr.write(`[remote] auth status ok: ${result.command}\n`);
      }
    }
    const bundle = await collectProfileAuth(profileName);
    assertRequiredAuthBundle(profileName, bundle);
    if (Object.keys(bundle).length > 0) credentials = bundle;
  }

  if (!credentials || Object.keys(credentials).length === 0) {
    process.stderr.write(
      `[remote] no credentials to refresh for session ${sessionId} (${profileName})\n`,
    );
    return;
  }

  const response = await refreshRemoteSession(baseUrl, sessionId, credentials);
  process.stderr.write(
    `[remote] refresh ${response.accepted ? "accepted" : "rejected"} for ${response.sessionId}\n`,
  );
}

async function pushAllProfiles(
  baseUrl: string,
  sessionId: string,
  opts: { authRefresh?: boolean },
): Promise<void> {
  const merged: Record<string, string> = {};
  const sent: string[] = [];
  for (const profile of CLI_PROFILES) {
    if (opts.authRefresh !== false) {
      try {
        await ensureProfileAuthFresh(profile);
      } catch {
        // a profile that fails its preflight is simply skipped in --all mode
        continue;
      }
    }
    const bundle = await collectProfileAuth(profile);
    if (Object.keys(bundle).length === 0) continue;
    Object.assign(merged, bundle);
    sent.push(profile);
  }
  if (sent.length === 0) {
    process.stderr.write(
      `[remote] no local credentials found for any profile; nothing to push\n`,
    );
    return;
  }
  process.stderr.write(
    `[remote] sending creds for ${sent.join(", ")} to ${baseUrl}/sessions/${sessionId}: ${Object.keys(merged).join(", ")}\n`,
  );
  const response = await refreshRemoteSession(baseUrl, sessionId, merged);
  process.stderr.write(
    `[remote] push ${response.accepted ? "accepted" : "rejected"} for ${response.sessionId}\n`,
  );
}

/** Validate `--watch <minutes>`: a whole number of minutes >= 1. */
export function parseWatchMinutes(raw: string): number {
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(
      `--watch needs a whole number of minutes >= 1 (got "${raw}")`,
    );
  }
  return minutes;
}

type SoftRefreshAllOutcome = {
  sessionId: string;
  profile: string;
  status: "ok" | "unchanged" | "failed";
  detail?: string;
};

/**
 * Unattended refresh passes (--all / --watch) must not abort on a flaky local
 * `auth status` preflight: the creds file local CLIs keep fresh is pushed
 * as-is, which is strictly better than letting the Pod's tokens expire.
 */
async function preflightOrWarn(profile: CliProfile): Promise<void> {
  try {
    const fresh = await ensureProfileAuthFresh(profile);
    if (fresh.checked) {
      process.stderr.write(`[remote] auth status ok: ${fresh.command}\n`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[remote] auth preflight failed (${detail.slice(0, 120)}) — pushing current creds anyway\n`,
    );
  }
}

/**
 * Soft-refresh EVERY live remote session (profile carried by each session).
 * Per-session errors don't stop the pass; ends with a recap (ok / unchanged /
 * failed) and returns the failure count. `hashes` carries the previous pass's
 * bundle hashes (sessionId -> sha256) so unchanged creds are a no-op WITHOUT
 * respawning the Pod CLI.
 */
export async function softRefreshAllSessions(
  url: string,
  opts: { authRefresh?: boolean },
  hashes: Map<string, string>,
): Promise<{ failed: number }> {
  const sessions = await listRemoteSessions(url);
  if (sessions.length === 0) {
    process.stderr.write("[remote] no live remote sessions to refresh\n");
    return { failed: 0 };
  }
  const preflighted = new Set<string>();
  const outcomes: SoftRefreshAllOutcome[] = [];
  for (const s of sessions) {
    const profile = coerceCliProfileName(s.profile);
    if (!profile) {
      outcomes.push({
        sessionId: s.id,
        profile: s.profile,
        status: "failed",
        detail: `unknown profile "${s.profile}"`,
      });
      continue;
    }
    try {
      if (opts.authRefresh !== false && !preflighted.has(profile)) {
        await preflightOrWarn(profile);
        preflighted.add(profile);
      }
      const previous = hashes.get(s.id);
      const result = await softRefreshSession(s.id, profile, {
        skipIfUnchanged: true,
        ...(previous !== undefined ? { previousHash: previous } : {}),
      });
      hashes.set(s.id, result.hash);
      outcomes.push({
        sessionId: s.id,
        profile,
        status: result.changed ? "ok" : "unchanged",
      });
    } catch (error) {
      outcomes.push({
        sessionId: s.id,
        profile,
        status: "failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          200,
        ),
      });
    }
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  process.stderr.write(
    `[remote] soft refresh recap — ${outcomes.length} session(s), ${failed} failed:\n`,
  );
  for (const o of outcomes) {
    process.stderr.write(
      `  ${o.sessionId} (${o.profile}) ${o.status}${o.detail ? ` — ${o.detail}` : ""}\n`,
    );
  }
  return { failed };
}

/** One gated soft-refresh pass for a single session (used by --watch <id>). */
async function softRefreshOneGated(
  url: string,
  sessionId: string,
  opts: RefreshOpts,
  hashes: Map<string, string>,
): Promise<{ failed: number }> {
  try {
    const profileName =
      opts.profile ?? (await getRemoteSession(url, sessionId)).session.profile;
    const profile = coerceCliProfileName(profileName);
    if (!profile) throw new Error(`Unknown profile "${profileName}"`);
    if (opts.authRefresh !== false) {
      await preflightOrWarn(profile);
    }
    const previous = hashes.get(sessionId);
    const result = await softRefreshSession(sessionId, profile, {
      skipIfUnchanged: true,
      ...(previous !== undefined ? { previousHash: previous } : {}),
    });
    hashes.set(sessionId, result.hash);
    process.stderr.write(
      `[remote] ${sessionId} (${profile}) ${result.changed ? "refreshed" : "unchanged"}\n`,
    );
    return { failed: 0 };
  } catch (error) {
    process.stderr.write(
      `[remote] ${sessionId} refresh failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
    );
    return { failed: 1 };
  }
}

/**
 * Foreground refresh loop for `--watch <minutes>`: pass, sleep, repeat. NO
 * daemonization, no pid file — the user runs it in a dedicated tmux window.
 * Each pass is timestamped on stderr; SIGINT (Ctrl-C) stops it cleanly with a
 * message and exit 0. Pass failures are logged and the loop keeps going.
 */
export async function watchRefreshLoop(
  minutes: number,
  pass: () => Promise<{ failed: number }>,
  // injectable so tests never emit a real SIGINT inside the test runner
  signals: {
    on(event: "SIGINT", listener: () => void): unknown;
    removeListener(event: "SIGINT", listener: () => void): unknown;
  } = process,
): Promise<number> {
  let stopped = false;
  let wake: (() => void) | undefined;
  const onSigint = () => {
    stopped = true;
    wake?.();
  };
  signals.on("SIGINT", onSigint);
  try {
    while (!stopped) {
      process.stderr.write(
        `[remote] refresh pass — ${new Date().toISOString()}\n`,
      );
      try {
        await pass();
      } catch (error) {
        process.stderr.write(
          `[remote] refresh pass failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
        );
      }
      if (stopped) break;
      process.stderr.write(
        `[remote] next pass in ${minutes} min (Ctrl-C to stop)\n`,
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, minutes * 60_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    signals.removeListener("SIGINT", onSigint);
  }
  process.stderr.write("[remote] watch stopped (SIGINT)\n");
  return 0;
}

/**
 * P4 — the conductor's FOREGROUND watch loop (NO daemon, NO pid file — run it in
 * a dedicated tmux window, exactly like `watchRefreshLoop` / `h2a bridge
 * --watch`). Each pass is timestamped; SIGINT (Ctrl-C) stops it cleanly with a
 * message and exit 0. A pass failure is logged and the loop keeps going. The
 * `pass` is the conductor pass (reconcile + start `pending` jobs under the cap);
 * `signals` is injectable so tests never emit a real SIGINT.
 */
export async function conductLoop(
  minutes: number,
  pass: () => Promise<{ started: number; finished: number }>,
  signals: {
    on(event: "SIGINT", listener: () => void): unknown;
    removeListener(event: "SIGINT", listener: () => void): unknown;
  } = process,
): Promise<number> {
  let stopped = false;
  let wake: (() => void) | undefined;
  const onSigint = () => {
    stopped = true;
    wake?.();
  };
  signals.on("SIGINT", onSigint);
  try {
    while (!stopped) {
      process.stderr.write(
        `[remote] conduct pass — ${new Date().toISOString()}\n`,
      );
      try {
        const { started, finished } = await pass();
        process.stderr.write(
          `[remote] conduct: ${started} started, ${finished} finished this pass\n`,
        );
      } catch (error) {
        process.stderr.write(
          `[remote] conduct pass failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
        );
      }
      if (stopped) break;
      process.stderr.write(
        `[remote] next conduct pass in ${minutes} min (Ctrl-C to stop)\n`,
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, minutes * 60_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    signals.removeListener("SIGINT", onSigint);
  }
  process.stderr.write("[remote] conduct stopped (SIGINT)\n");
  return 0;
}

// ---------------------------------------------------------------------------
// P4 — startJob: the EFFECTIVE launch (local tmux / remote Pod) of one job,
// factored out of the `delegate` action so BOTH `delegate` (when a slot is free)
// and the conductor (draining the `pending` queue) launch jobs the same way.
// ---------------------------------------------------------------------------

export type StartJobResult =
  | { started: true; target: "local" | "remote"; detail: string }
  | { started: false; error: string };

/**
 * Launch a job that is enrolled in the registry (typically `pending`): spawn the
 * agent (local detached tmux, or a Pod), advance the registry entry to
 * `running`, mirror it under track (best-effort), and propagate the spawn-depth
 * budget to the child via `REMOTE_DELEGATE_DEPTH`. The launch params are read
 * from the entry's queued-launch fields (tool/task/headless/remoteTarget/
 * originCwd/explicitCwd/depthBudget/trackWp), set at `delegate` time.
 *
 * Never throws: any spawn/registry error is returned as `{started:false}` so the
 * conductor loop keeps going. For remote, the per-job workspace is created here
 * (so a queued remote job doesn't hold a workspace while waiting).
 */
export async function startJob(job: RegistryEntry): Promise<StartJobResult> {
  const task = job.task ?? "";
  const headless = job.headless === true;
  const trackWp = job.trackWp;
  // Mirror the job under track as soon as it actually starts (best-effort).
  const mirrorNew = () => {
    if (trackWp) {
      runTrackMirror(
        trackItemNewArgs(trackWp, { id: job.id, ...(job.task !== undefined ? { task: job.task } : {}) }),
        job.originCwd ?? process.cwd(),
      );
    }
  };

  // --- REMOTE (P2 path), now also queue-driven. -----------------------------
  if (job.remoteTarget !== undefined) {
    try {
      const url = job.remoteTarget;
      await ensureConnected(url);
      const ws = await createWorkspace(url, { displayName: `job-${job.id}` });
      const remoteArgs = buildRemoteDelegate(job.tool, task, headless);
      const session = await createRemoteSession(url, {
        profile: remoteArgs.profile,
        target: getDefaultTarget(),
        workspaceId: ws.id,
        displayName: `job-${job.id}`,
        ...(remoteArgs.startupArgs.length > 0
          ? { startupArgs: remoteArgs.startupArgs }
          : {}),
      });
      enroll({
        id: job.id,
        tool: job.tool,
        kind: "remote",
        cwd: ws.id,
        source: "remote",
        label: job.id,
        remoteId: session.id,
        role: "job",
        jobState: "running",
        // Persist originCwd so reconcile reads result.json under the right dir
        // (H2) regardless of the conductor's cwd.
        ...(job.originCwd !== undefined ? { originCwd: job.originCwd } : {}),
      });
      mirrorNew();
      return {
        started: true,
        target: "remote",
        detail: `${url}/sessions/${session.id} (workspace ${ws.id})`,
      };
    } catch (err) {
      return { started: false, error: (err as Error).message };
    }
  }

  // --- LOCAL (P1 path), now also queue-driven. ------------------------------
  if (!tmuxAvailable()) {
    return { started: false, error: "tmux is not installed locally" };
  }
  const originCwd = job.originCwd ?? process.cwd();
  let argv: { command: string; args: string[] };
  try {
    argv = buildDelegateArgs(job.tool, task, headless);
  } catch (err) {
    return { started: false, error: (err as Error).message };
  }
  let runCwd: string;
  let isolated: boolean;
  try {
    ({ runCwd, isolated } = resolveJobCwd(originCwd, job.id, {
      ...(job.explicitCwd !== undefined ? { explicitCwd: job.explicitCwd } : {}),
    }));
  } catch (err) {
    return { started: false, error: (err as Error).message };
  }

  // Propagate the child's remaining spawn-depth budget through the env so a job
  // that itself runs `remote delegate` inherits a DECREMENTED budget (depth=0 →
  // refuse). tmux inherits the spawning process's env, so set it around spawn.
  // ALSO stamp REMOTE_JOB_ID (H1): the spawned agent's claude SessionStart/End
  // hooks read it to resolve THIS job (they only get claude's conversation uuid,
  // not the job slug), so an interactive tmux job actually completes.
  const prevDepth = process.env[DEPTH_ENV];
  const prevJobId = process.env[JOB_ID_ENV];
  process.env[DEPTH_ENV] = childDepthEnvValue(job.depthBudget ?? clampDepth(undefined));
  process.env[JOB_ID_ENV] = job.id;
  let tmuxSession: string;
  try {
    if (headless) {
      const dir = jobDir(originCwd, job.id);
      ({ name: tmuxSession } = startHeadlessSession(
        job.tool,
        argv.command,
        runCwd,
        argv.args,
        join(dir, "result.json"),
        join(dir, "output.log"),
        job.id,
      ));
    } else {
      ({ name: tmuxSession } = startLocalSession(
        job.tool,
        argv.command,
        runCwd,
        argv.args,
        job.id,
      ));
      const h2a = getH2aConfig();
      startH2aWindow(tmuxSession, runCwd, h2a.command);
    }
  } catch (err) {
    return { started: false, error: (err as Error).message };
  } finally {
    if (prevDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prevDepth;
    if (prevJobId === undefined) delete process.env[JOB_ID_ENV];
    else process.env[JOB_ID_ENV] = prevJobId;
  }

  enroll({
    id: job.id,
    tool: job.tool,
    kind: "local-tmux",
    cwd: runCwd,
    source: "run",
    label: job.id,
    tmuxSession,
    role: "job",
    jobState: "running",
    // Persist originCwd (H2): result.json/output.log live under originCwd, read
    // by reconcile/status/logs no matter where the conductor runs from.
    originCwd,
    ...(job.task !== undefined ? { task: job.task } : {}),
    ...(job.callbackTo !== undefined ? { callbackTo: job.callbackTo } : {}),
  });
  mirrorNew();
  return {
    started: true,
    target: "local",
    detail: `${runCwd}${isolated ? " [worktree]" : ""}`,
  };
}

function getConfiguredRemote(overrideUrl?: string): string {
  const remote = overrideUrl ?? getConfiguredRemoteOptional();
  if (!remote) {
    throw new Error(
      "No remote URL configured. Set one with `remote config set <url>` (or `remote install <url>`) or pass --remote/URL explicitly.",
    );
  }
  return remote;
}

function getConfiguredRemoteOptional(): string | undefined {
  try {
    return getDefaultRemote();
  } catch {
    return undefined;
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Resolve the tool list to bundle: `--with a,b` overrides the configured
 * default (`remote config tools …`). Unknown tools are dropped with a warning.
 */
function resolveTools(withOpt?: string): string[] {
  const raw = withOpt
    ? withOpt.split(",").map((s) => s.trim()).filter(Boolean)
    : getDefaultTools();
  const { known, unknown } = partitionTools(raw);
  if (unknown.length > 0) {
    process.stderr.write(
      `[remote] ignoring unknown tools: ${unknown.join(", ")} (known: ${KNOWN_TOOLS.join(", ")})\n`,
    );
  }
  return known;
}

/** Friendly project name for a session: displayName, else the workspace dir basename, else the id. */
function projectName(s: {
  displayName?: string;
  workspacePath?: string;
  id: string;
}): string {
  const dn = s.displayName?.trim();
  if (dn) return dn;
  if (s.workspacePath) {
    const base = s.workspacePath.replace(/\/+$/, "").split("/").pop();
    if (base) return base;
  }
  return s.id;
}

/** Local CLI binary for a profile (used by `remote run`). */
const LOCAL_CLI: Readonly<Record<string, string>> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  agy: "agy",
  antigravity: "agy",
  opencode: "opencode",
  shell: "/bin/bash",
};

function localCliCommand(profile: string): string {
  return LOCAL_CLI[profile] ?? profile;
}

/** CLI args to resume a specific conversation, per profile. */
function localResumeArgs(profile: string, convId: string): string[] {
  switch (profile) {
    case "claude":
    case "claude-code":
      return ["--resume", convId];
    case "codex":
      return ["resume", convId];
    case "agy":
    case "antigravity":
      return ["--resume", convId];
    default:
      return [];
  }
}

function resolveUrlAndSessionId(
  first: string,
  second: string | undefined,
): { url: string; sessionId: string } {
  if (second !== undefined) {
    return { url: getConfiguredRemote(first), sessionId: second };
  }
  if (looksLikeUrl(first)) {
    throw new Error(
      `Missing session id. Usage: remote <command> [url] <sessionId> (received URL "${first}" without session id).`,
    );
  }
  return { url: getConfiguredRemote(), sessionId: first };
}

function setAndReportDefaultRemote(url: string): void {
  const configured = setDefaultRemote(url);
  process.stderr.write(`[remote] default remote set to ${configured}\n`);
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const program = new Command();
  program
    .name("remote")
    .description(
      "Wrap a local agent CLI (codex/claude/agy) and expose its session for remote attach.",
    )
    .version("0.0.0");

  for (const [profileName, alias] of [
    ["codex", undefined],
    ["claude", "claude-code"],
    ["agy", "antigravity"],
    ["opencode", undefined],
    ["shell", undefined],
  ] as const) {
    const cmd = program
      .command(profileName)
      .description(`Run ${profileName} via remote-cli`)
      .argument("[commandArgs...]", "Arguments passed to the wrapped CLI")
      .option(
        "-r, --resume [convId]",
        "resume the wrapped CLI's last conversation (or a specific one by id) using its native --continue/--resume flag",
      )
      .option(
        "-p, --port <port>",
        "expose the in-process control-plane on this port",
        (value: string) => Number(value),
      )
      .option(
        "--remote <url>",
        "override the control-plane URL (defaults to the configured remote; `remote` is remote-first)",
      )
      .option(
        "--local",
        "run the CLI in-process via a local PTY instead of a remote session",
      )
      .option(
        "--sync",
        "seed the remote /workspace with the current directory (honors .gitignore)",
      )
      .option(
        "--no-workspace",
        "ignore the .remote/ mapping and use a throwaway workspace",
      )
      .option(
        "--target <target>",
        "remote session target: k3s, scaleway-kapsule, or gke",
        "k3s",
      )
      .option("--no-auth", "skip bundling local credentials")
      .option(
        "--no-auth-refresh",
        "skip local auth status preflight before bundling credentials",
      )
      .option(
        "--count <n>",
        `fan out N concurrent REMOTE sessions (named <base>-NN), each on its OWN workspace subPath of the shared RWX volume (cap ${DEFAULT_FANOUT_MAX}); never auto-attaches`,
        (value: string) => Number(value),
      )
      .option(
        "--name <label>",
        "base label for the --count fan-out fleet names (default: cwd basename)",
      )
      .action(async (commandArgs: string[] | undefined, opts: ProfileCliOpts) => {
        const { remote: remoteOverride, local, workspace, ...rest } = opts;
        if (local) {
          try {
            await runProfile(profileName, { ...rest }, commandArgs ?? []);
          } catch (err) {
            process.stderr.write(`[remote] ${(err as Error).message}\n`);
            process.exitCode = 1;
          }
          return;
        }
        // WP6 — a fan-out (--count>1) needs N DISTINCT workspaces, so the cwd's
        // single .remote/ mapping must NOT pin every member to one subPath:
        // ignore the marker in that case (each member gets its own workspace).
        const fanout = (rest.count ?? 1) > 1;
        const marker =
          workspace === false || fanout
            ? undefined
            : readWorkspaceMarker(process.cwd());
        const remote = getConfiguredRemote(remoteOverride ?? marker?.remote);
        if (marker) {
          process.stderr.write(
            `[remote] cwd mapped to ${marker.workspaceId} (reusing workspace)\n`,
          );
        }
        try {
          await runProfile(
            profileName,
            {
              ...rest,
              remote,
              ...(marker ? { workspaceId: marker.workspaceId } : {}),
            },
            commandArgs ?? [],
          );
        } catch (err) {
          process.stderr.write(`[remote] ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      });
    if (alias) cmd.alias(alias);
  }

  program
    .command("install <url>")
    .description("Set default remote URL for commands that omit remote URL")
    .action((url: string) => {
      setAndReportDefaultRemote(url);
    });

  const workspaceCommand = program
    .command("workspace")
    .description(
      "Map the current project to a persistent remote workspace and sync files",
    );

  workspaceCommand
    .command("link")
    .description(
      "Create a persistent remote workspace and write the .remote/ mapping for the cwd",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .option("--name <name>", "display name for the workspace")
    .action(async (opts: { remote?: string; name?: string }) => {
      const cwd = process.cwd();
      const existing = readWorkspaceMarker(cwd);
      if (existing) {
        process.stderr.write(
          `[remote] ${cwd} already mapped to ${existing.workspaceId} (${existing.remote})\n`,
        );
        return;
      }
      const remote = getConfiguredRemote(opts.remote);
      const ws = await createWorkspace(
        remote,
        opts.name ? { displayName: opts.name } : {},
      );
      writeWorkspaceMarker(cwd, { remote, workspaceId: ws.id });
      process.stderr.write(
        `[remote] linked ${cwd} -> ${ws.id} (wrote .remote/workspace.json)\n`,
      );
    });

  workspaceCommand
    .command("list [url]")
    .description("List persistent workspaces on a remote control-plane")
    .action(async (url: string | undefined) => {
      const remote = getConfiguredRemote(url);
      const workspaces = await listWorkspaces(remote);
      if (workspaces.length === 0) {
        process.stderr.write("[remote] no workspaces\n");
        return;
      }
      const rows = workspaces.map((w) =>
        [w.id, w.createdAt, w.displayName ?? ""].join("\t"),
      );
      process.stdout.write(
        ["ID\tCREATED\tDISPLAY", ...rows].join("\n") + "\n",
      );
    });

  workspaceCommand
    .command("status")
    .description("Show the workspace mapping for the current directory")
    .action(() => {
      const marker = readWorkspaceMarker(process.cwd());
      if (!marker) {
        process.stdout.write(
          "[remote] no workspace mapped for this directory (run `remote workspace link`)\n",
        );
        return;
      }
      process.stdout.write(`workspace: ${marker.workspaceId}\n`);
      process.stdout.write(`remote: ${marker.remote}\n`);
    });

  const requireMarker = (cwd: string) => {
    const marker = readWorkspaceMarker(cwd);
    if (!marker) {
      throw new Error(
        "No workspace mapped for this directory. Run `remote workspace link` first.",
      );
    }
    return marker;
  };

  const guardLock = async (
    remote: string,
    workspaceId: string,
    force: boolean,
  ): Promise<void> => {
    const lock = await acquireWorkspaceLock(
      remote,
      workspaceId,
      lockHolderId(),
    );
    if (!lock.acquired) {
      if (!force) {
        throw new Error(
          `Workspace ${workspaceId} is held by ${lock.holder} since ${lock.since}. ` +
            `Coordinate, or pass --force to override the soft lock.`,
        );
      }
      process.stderr.write(
        `[remote] warning: overriding soft lock held by ${lock.holder} (--force)\n`,
      );
    }
  };

  workspaceCommand
    .command("push")
    .description(
      "Upload the current directory into the mapped workspace's persistent volume (honors .gitignore)",
    )
    .option("--force", "override a soft lock held by another editor")
    .action(async (opts: { force?: boolean }) => {
      const cwd = process.cwd();
      const marker = requireMarker(cwd);
      await guardLock(marker.remote, marker.workspaceId, opts.force ?? false);
      try {
        process.stderr.write(
          `[remote] packing ${cwd} (respecting .gitignore)\n`,
        );
        const archive = await buildWorkspaceArchive(cwd);
        process.stderr.write(
          `[remote] archive: ${(archive.byteLength / 1024).toFixed(0)} KiB -> ${marker.workspaceId}\n`,
        );
        // Reuse the --sync path via a throwaway session bound to the workspace:
        // the session-agent extracts the archive into the retained PVC, then the
        // shell exits and the session auto-cleans (the workspace PVC is kept).
        const session = await createRemoteSession(marker.remote, {
          profile: "shell",
          workspaceId: marker.workspaceId,
          workspaceSync: true,
          startupArgs: ["-c", "exit 0"],
        });
        await uploadWorkspaceArchive(marker.remote, session.id, archive);
        const attached = await attach({
          baseUrl: marker.remote,
          sessionId: session.id,
        });
        await attached.finished;
        // The pushed tree is now the shared sync base.
        writeBaseSnapshot(cwd, archive);
        process.stderr.write(`[remote] pushed ${cwd} to ${marker.workspaceId}\n`);
      } finally {
        await releaseWorkspaceLock(marker.remote, marker.workspaceId);
      }
    });

  workspaceCommand
    .command("pull")
    .description(
      "Fetch the mapped workspace and 3-way merge it into the current directory",
    )
    .option("--force", "override a soft lock held by another editor")
    .option(
      "--restore-sessions",
      "also restore CLI conversation state (codex/claude/agy) into your local HOME",
    )
    .option(
      "--on-conflict <mode>",
      "for diverged conversations: backup | keep-local (default: block & report)",
    )
    .action(
      async (opts: {
        force?: boolean;
        restoreSessions?: boolean;
        onConflict?: string;
      }) => {
      const cwd = process.cwd();
      const marker = requireMarker(cwd);
      await guardLock(marker.remote, marker.workspaceId, opts.force ?? false);
      try {
        // Export the live /workspace via a bound session. The session-agent
        // uploads the export on startup (before the shell), so we keep the
        // shell alive, poll for the export, then stop the session explicitly —
        // otherwise the terminal.exited cleanup cascade would drop the export
        // before we could download it.
        const session = await createRemoteSession(marker.remote, {
          profile: "shell",
          workspaceId: marker.workspaceId,
          workspaceExport: true,
          startupArgs: ["-c", "sleep 120"],
        });
        let remoteArchive: Buffer | null = null;
        try {
          for (let attempt = 0; attempt < 60; attempt++) {
            remoteArchive = await downloadWorkspaceExport(
              marker.remote,
              session.id,
            );
            if (remoteArchive) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
        } finally {
          await stopRemoteSession(marker.remote, session.id, "pull-complete");
        }
        if (!remoteArchive) {
          process.stderr.write(
            `[remote] nothing to pull (workspace ${marker.workspaceId} produced no export)\n`,
          );
          return;
        }
        const result = mergeWorkspaceArchive({
          cwd,
          remoteArchive,
          baseArchive: readBaseSnapshot(cwd),
        });
        process.stderr.write(
          `[remote] pull: ${result.tookRemote.length} from remote, ${result.keptLocal.length} kept local, ${result.merged.length} merged\n`,
        );
        if (result.conflicts.length > 0) {
          process.stderr.write(
            `[remote] ${result.conflicts.length} conflict(s) (left with markers, resolve then re-run):\n`,
          );
          for (const f of result.conflicts) process.stderr.write(`  ${f}\n`);
          process.exitCode = 1;
          return;
        }
        // Clean merge → the remote tree is the new shared base.
        writeBaseSnapshot(cwd, remoteArchive);
        process.stderr.write(`[remote] pulled ${marker.workspaceId} into ${cwd}\n`);

        if (opts.restoreSessions) {
          const onConflict: OnConflict =
            opts.onConflict === "backup"
              ? "backup"
              : opts.onConflict === "keep-local"
                ? "keep-local"
                : "block";
          const home = process.env.HOME ?? "";
          let anyConflict = false;
          for (const profile of CLI_PROFILES) {
            const r = restoreSessionsToLocal({
              home,
              profile,
              remoteArchive,
              onConflict,
            });
            const touched =
              r.restored.length + r.backedUp.length + r.conflicts.length;
            if (touched === 0 && r.keptLocal.length === 0) continue;
            process.stderr.write(
              `[remote] sessions(${profile}): ${r.restored.length} restored, ${r.backedUp.length} backed-up, ${r.keptLocal.length} kept, ${r.conflicts.length} conflict\n`,
            );
            for (const b of r.backedUp)
              process.stderr.write(`    backup ${b}\n`);
            if (r.conflicts.length > 0) {
              anyConflict = true;
              for (const c of r.conflicts)
                process.stderr.write(`    conflict ${c}\n`);
            }
          }
          if (anyConflict) {
            process.stderr.write(
              `[remote] diverged conversations left untouched. Re-run with --on-conflict backup (keep both) or keep-local.\n`,
            );
            process.exitCode = 1;
          }
        }
      } finally {
        await releaseWorkspaceLock(marker.remote, marker.workspaceId);
      }
    });

  workspaceCommand
    .command("rm [workspaceId]")
    .description(
      "Delete a workspace (defaults to the cwd's mapped workspace) and its retained volume",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (workspaceId: string | undefined, opts: { remote?: string }) => {
      const marker = readWorkspaceMarker(process.cwd());
      const remote = getConfiguredRemote(opts.remote ?? marker?.remote);
      const id = workspaceId ?? marker?.workspaceId;
      if (!id) {
        throw new Error(
          "No workspace id given and no .remote/ mapping in this directory.",
        );
      }
      const deleted = await deleteWorkspace(remote, id);
      process.stderr.write(
        deleted
          ? `[remote] deleted workspace ${id}\n`
          : `[remote] workspace ${id} not found\n`,
      );
    });

  workspaceCommand
    .command("gc")
    .description(
      "Garbage-collect stale workspace directories on the shared remote volume (dry-run unless --apply)",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .option(
      "--older-than <days>",
      "only directories with no activity for at least <days> days (default 30)",
    )
    .option(
      "--apply",
      "archive each candidate to the volume's .trash/ then delete it (asks for confirmation)",
    )
    .option("--yes", "skip the interactive confirmation (only with --apply)")
    .action(
      async (opts: {
        remote?: string;
        olderThan?: string;
        apply?: boolean;
        yes?: boolean;
      }) => {
        // Self-contained block (dynamic imports) so this command stays ONE
        // contiguous addition to index.ts — no shared import-list edits.
        const { requestWorkspaceGc } = await import("./workspace.js");
        const remote = getConfiguredRemote(opts.remote);
        // The configured remote is usually behind the on-demand tunnel — bring
        // it up like every other remote command does (ls/diff/sync/…).
        await ensureConnected(remote);
        const olderThanDays =
          opts.olderThan !== undefined ? Number(opts.olderThan) : 30;
        if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
          throw new Error("--older-than must be a whole number of days >= 1");
        }

        // ALWAYS show the dry-run first — even with --apply nothing is touched
        // before the candidate list has been printed (and confirmed).
        const dryRun = await requestWorkspaceGc(remote, { olderThanDays });
        if (dryRun.candidates.length === 0) {
          process.stderr.write(
            `[remote] workspace gc: no candidates older than ${olderThanDays} day(s) — nothing to do\n`,
          );
          return;
        }
        process.stderr.write(
          `[remote] workspace gc: ${dryRun.candidates.length} candidate(s) older than ${olderThanDays} day(s) (workspaces of known sessions are always kept):\n`,
        );
        process.stdout.write(
          [
            "ID\tSIZE\tLAST-MODIFIED",
            ...dryRun.candidates.map(
              (c) => `${c.id}\t${c.sizeH}\t${c.lastModified}`,
            ),
          ].join("\n") + "\n",
        );
        if (!opts.apply) {
          process.stderr.write(
            "[remote] dry-run only — nothing was deleted. Re-run with --apply to archive these to the volume's .trash/ and remove them.\n",
          );
          return;
        }

        if (!opts.yes) {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          const answer = (
            await rl.question(
              `[remote] archive ${dryRun.candidates.length} director(y/ies) to on-volume .trash/ and DELETE them? [y/N] `,
            )
          )
            .trim()
            .toLowerCase();
          rl.close();
          if (answer !== "y" && answer !== "yes") {
            process.stderr.write("[remote] aborted — nothing was deleted\n");
            return;
          }
        }

        const report = await requestWorkspaceGc(remote, {
          olderThanDays,
          apply: true,
        });
        // The janitor re-checks keep-list and age at apply time, so the applied
        // set can legitimately be smaller than the dry-run shown above.
        for (const c of report.candidates) {
          process.stderr.write(
            `[remote] archived ${c.id} (${c.sizeH}) -> ${c.archivedTo ?? ".trash/"} then removed\n`,
          );
        }
        for (const f of report.failed ?? []) {
          process.stderr.write(
            `[remote] FAILED ${f.id}: ${f.reason} — directory left untouched\n`,
          );
        }
        if ((report.failed ?? []).length > 0) process.exitCode = 1;
        if (report.candidates.length === 0) {
          process.stderr.write(
            "[remote] nothing collected (candidates became active or protected since the dry-run)\n",
          );
        } else {
          process.stderr.write(
            `[remote] workspace gc done: ${report.candidates.length} archived+removed (recoverable from the volume's .trash/)\n`,
          );
        }
      },
    );

  const authCommand = program
    .command("auth")
    .description("Inspect and manage the local CLI credentials remote sends to sessions");

  const printAuthStatus = async (
    profile: CliProfile,
    opts: AuthDiagnosticOpts,
  ): Promise<void> => {
    const result = await inspectProfileAuth(profile, {
      ...(opts.authRefresh !== undefined ? { authRefresh: opts.authRefresh } : {}),
    });
    process.stdout.write(`profile: ${result.profile}\n`);
    process.stdout.write(
      `auth status: ${describeAuthStatus(result.authStatus)}\n`,
    );
    process.stdout.write(`bundled files: ${result.bundledFiles.length}\n`);
    for (const file of result.bundledFiles) {
      process.stdout.write(`- ${file}\n`);
    }
  };

  authCommand
    .command("status [profile]")
    .description(
      "Show local auth status and which credential files would be sent. With --all, report every profile.",
    )
    .option("--all", "report every known CLI profile")
    .option(
      "--no-auth-refresh",
      "skip the local auth status preflight and only inspect bundled files",
    )
    .action(
      async (
        profileName: string | undefined,
        opts: AuthDiagnosticOpts & { all?: boolean },
      ) => {
        if (opts.all) {
          for (const profile of CLI_PROFILES) {
            await printAuthStatus(profile, opts);
            process.stdout.write("\n");
          }
          return;
        }
        if (!profileName) {
          throw new Error(
            "Specify a profile (e.g. `remote auth status codex`) or pass --all.",
          );
        }
        const profile = coerceCliProfileName(profileName);
        if (!profile) {
          throw new Error(
            `Unknown profile "${profileName}". Known: codex, claude, agy, opencode, shell (aliases: claude-code, antigravity)`,
          );
        }
        await printAuthStatus(profile, opts);
      },
    );

  authCommand
    .command("login <profile>")
    .description(
      "Run the CLI's local login flow (for the not-yet-authenticated case), then show status",
    )
    .action(async (profileName: string) => {
      const profile = coerceCliProfileName(profileName);
      if (!profile) {
        throw new Error(
          `Unknown profile "${profileName}". Known: codex, claude, agy, opencode, shell (aliases: claude-code, antigravity)`,
        );
      }
      const loginCommand = getLoginCommand(profile);
      if (!loginCommand) {
        process.stderr.write(
          `[remote] ${profile} has no scripted login. Run \`${profile}\` directly and complete its sign-in flow (browser / SSH-mode URL), then \`remote auth status ${profile}\`.\n`,
        );
        return;
      }
      process.stderr.write(
        `[remote] running ${loginCommand.command} ${loginCommand.args.join(" ")}\n`,
      );
      const code = await runInteractiveLogin(loginCommand);
      if (code !== 0) {
        process.stderr.write(
          `[remote] login exited with code ${code}; check the output above.\n`,
        );
        process.exitCode = code;
        return;
      }
      await printAuthStatus(profile, {});
    });

  authCommand
    .command("push <urlOrSessionId> [sessionId]")
    .description(
      "Send local credentials to an existing remote session's Secret (the Pod is restarted). URL optional when a default remote is configured. Profile is auto-detected; --all sends every profile that has local creds.",
    )
    .option(
      "--profile <profile>",
      "override the auto-detected profile (rarely needed)",
    )
    .option("--all", "bundle and send every local profile's credentials")
    .option(
      "--soft",
      "push fresh creds INTO the running Pod + relaunch the CLI in place (no Pod recreate; keeps HOME + conversation; fixes the ~8h token logout)",
    )
    .option(
      "--no-auth-refresh",
      "skip the local auth status preflight before bundling",
    )
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: RefreshOpts & { all?: boolean; soft?: boolean },
      ) => {
        const { url, sessionId } = resolveUrlAndSessionId(first, second);
        if (opts.soft) {
          await ensureConnected(url);
          const profile =
            opts.profile ?? (await getRemoteSession(url, sessionId)).session.profile;
          const resolved = coerceCliProfileName(profile);
          if (!resolved) throw new Error(`Unknown profile "${profile}"`);
          if (opts.authRefresh !== false) {
            const fresh = await ensureProfileAuthFresh(resolved);
            if (fresh.checked)
              process.stderr.write(`[remote] auth status ok: ${fresh.command}\n`);
          }
          await softRefreshSession(sessionId, resolved);
          return;
        }
        if (opts.all) {
          await pushAllProfiles(url, sessionId, opts);
          return;
        }
        await refreshProfileSession(url, sessionId, opts);
      },
    );

  const checkAction = async (profileName: string, opts: SmokeOpts) => {
    const profile = coerceCliProfileName(profileName);
    if (!profile) {
      throw new Error(
        `Unknown profile "${profileName}". Known: codex, claude, agy, opencode, shell (aliases: claude-code, antigravity)`,
      );
    }
    const remote = getConfiguredRemote(opts.remote);
    const result = await smokeRemoteProfile({
      profile,
      baseUrl: remote,
      target: opts.target ?? getDefaultTarget(),
      timeoutMs: opts.timeout ?? 120_000,
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.authRefresh !== undefined
        ? { authRefresh: opts.authRefresh }
        : {}),
    });
    process.stdout.write(`profile: ${result.profile}\n`);
    process.stdout.write(`session: ${result.sessionId}\n`);
    process.stdout.write(`terminal: ${result.terminalId}\n`);
    process.stdout.write(`shell: ${result.shell}\n`);
    process.stdout.write("stopped: true\n");
  };

  const checkCommand = program
    .command("check <profile>")
    .alias("smoke")
    .description(
      "End-to-end probe: create a remote session for <profile>, wait for the Pod's terminal.opened, then stop it. Exits non-zero on failure.",
    )
    .option(
      "--remote [url]",
      "remote control-plane base URL, for example http://localhost:8080",
    )
    .option(
      "--target <target>",
      "remote session target: k3s, scaleway-kapsule, or gke",
      "k3s",
    )
    .option(
      "--timeout <ms>",
      "milliseconds to wait for terminal.opened",
      (value) => Number(value),
      120_000,
    )
    .option("--no-auth", "skip bundling local credentials")
    .option(
      "--no-auth-refresh",
      "skip local auth status preflight before bundling credentials",
    )
    .action(checkAction);
  void checkCommand;

  const configCommand = program
    .command("config")
    .description("Manage remote endpoint configuration");

  configCommand
    .command("set <url>")
    .description("Set default remote URL (used when URL is not passed)")
    .action((url: string) => {
      setAndReportDefaultRemote(url);
    });

  configCommand
    .command("token <value>")
    .description(
      "Store the bearer token sent as Authorization on control-plane requests (overridden by $REMOTE_TOKEN)",
    )
    .action((value: string) => {
      setToken(value);
      process.stderr.write("[remote] stored bearer token\n");
    });

  configCommand
    .command("target <target>")
    .description(
      "Set the default session target label (where the workload runs), e.g. scaleway-kapsule",
    )
    .action((target: string) => {
      setDefaultTarget(target);
      process.stderr.write(`[remote] default target set to ${target}\n`);
    });

  configCommand
    .command("tools <list>")
    .description(
      `Set the default tool CLIs whose auth is bundled into deported sessions (comma-separated, known: ${KNOWN_TOOLS.join(", ")}; use "none" to clear)`,
    )
    .action((list: string) => {
      const requested =
        list.trim() === "none"
          ? []
          : list.split(",").map((s) => s.trim()).filter(Boolean);
      const { known, unknown } = partitionTools(requested);
      if (unknown.length > 0) {
        process.stderr.write(
          `[remote] unknown tools ignored: ${unknown.join(", ")}\n`,
        );
      }
      setDefaultTools(known);
      process.stderr.write(
        `[remote] default tools: ${known.length > 0 ? known.join(", ") : "(none)"}\n`,
      );
    });

  configCommand
    .command("clear")
    .description("Clear default remote URL")
    .action(() => {
      clearDefaultRemote();
      process.stderr.write("[remote] cleared default remote\n");
    });

  configCommand
    .command("show")
    .description("Display configured default remote URL (and tunnel, if any)")
    .action(() => {
      const remote = getDefaultRemote();
      process.stdout.write(
        remote ? `${remote}\n` : "[remote] no default remote configured\n",
      );
      process.stdout.write(`target: ${getDefaultTarget()}\n`);
      const tools = getDefaultTools();
      if (tools.length > 0) process.stdout.write(`tools: ${tools.join(", ")}\n`);
      const tunnel = getTunnel();
      if (tunnel) {
        process.stdout.write(
          `tunnel: kubectl -n ${tunnel.namespace} port-forward svc/${tunnel.service} ${tunnel.localPort}:${tunnel.remotePort}` +
            `${tunnel.kubeconfig ? ` (kubeconfig ${tunnel.kubeconfig})` : ""}\n`,
        );
      }
    });

  configCommand
    .command("tunnel")
    .description(
      "Configure how the CLI reaches the control-plane when there is no public ingress (kubectl port-forward, opened automatically on connect/attach/ls/migrate)",
    )
    .requiredOption("--namespace <ns>", "namespace of the control-plane service")
    .requiredOption("--service <svc>", "control-plane Service name")
    .option("--kubeconfig <path>", "kubeconfig path (~ is expanded)")
    .option("--local-port <port>", "local port", (v: string) => parseInt(v, 10), 8080)
    .option("--remote-port <port>", "service port", (v: string) => parseInt(v, 10), 8080)
    .action(
      (opts: {
        namespace: string;
        service: string;
        kubeconfig?: string;
        localPort: number;
        remotePort: number;
      }) => {
        const tunnel: TunnelConfig = {
          namespace: opts.namespace,
          service: opts.service,
          localPort: opts.localPort,
          remotePort: opts.remotePort,
          ...(opts.kubeconfig ? { kubeconfig: opts.kubeconfig } : {}),
        };
        setTunnel(tunnel);
        process.stderr.write(
          `[remote] tunnel configured: kubectl -n ${tunnel.namespace} port-forward svc/${tunnel.service} ${tunnel.localPort}:${tunnel.remotePort}\n`,
        );
      },
    );

  // ---------------------------------------------------------------------------
  // connect / disconnect — manage the on-demand tunnel
  // ---------------------------------------------------------------------------

  program
    .command("connect")
    .description(
      "Ensure the control-plane is reachable, opening the configured tunnel if needed",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (opts: { remote?: string }) => {
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      process.stderr.write(`[remote] connected: ${url}\n`);
    });

  program
    .command("disconnect")
    .description("Close the managed control-plane tunnel (if any)")
    .action(() => {
      const stopped = stopTunnel();
      process.stderr.write(
        stopped
          ? "[remote] tunnel closed\n"
          : "[remote] no managed tunnel was running\n",
      );
    });

  program
    .command("status")
    .description(
      "Unified view: local active CLI sessions + remote sessions (correlated by path, with agent health) + local tool auth",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (opts: { remote?: string }) => {
      const now = Date.now();
      const ACTIVE_MS = 10 * 60 * 1000;

      // Remote sessions + health, indexed by workspace path for correlation.
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      const remote = await listRemoteSessions(url);
      const health = new Map<string, string>();
      for (const s of remote) health.set(s.id, await sessionTerminalHealth(url, s.id));
      const remoteByPath = new Map<string, (typeof remote)[number]>();
      for (const s of remote) if (s.workspacePath) remoteByPath.set(s.workspacePath, s);
      const mark = (id: string): string => {
        const h = health.get(id);
        return h === "ready" ? "● ready" : h === "agent-down" ? "○ down" : "? unknown";
      };

      // LOCAL sessions (claude conversations), newest first; "●" = active <10min.
      const local = listMigrationCandidates();
      process.stdout.write("LOCAL sessions (claude):\n");
      if (local.length === 0) process.stdout.write("  (none)\n");
      for (const c of local) {
        const r = c.exists ? remoteByPath.get(c.path) : undefined;
        const dot = now - c.lastActivity < ACTIVE_MS ? "●" : "·";
        const tail = r
          ? `→ remote ${r.id} (${mark(r.id)})`
          : c.linked
            ? "(migrated, not live)"
            : "";
        process.stdout.write(
          `  ${dot} ${humanAge(c.lastActivity, now).padStart(4)} ago  ${c.path}${c.isGit ? "" : " [non-git]"}  ${tail}\n`,
        );
      }

      // REMOTE sessions (cluster), with health + mapped path.
      process.stdout.write(`\nREMOTE sessions @ ${url}:\n`);
      if (remote.length === 0) process.stdout.write("  (none)\n");
      for (const s of remote) {
        process.stdout.write(
          `  ${mark(s.id).padEnd(11)} ${projectName(s).padEnd(20)} ${(s.profile ?? "").padEnd(7)} ${s.id}  creds: ${secretsSummary(s.id)}\n`,
        );
      }

      // Local tool auth (what you can bundle into a deported session).
      process.stdout.write("\nLOCAL tool auth (deport with --with / 'config tools'):\n");
      for (const t of detectToolAuth()) {
        process.stdout.write(
          `  ${t.present ? "✓" : "·"} ${t.tool.padEnd(8)} ${t.present ? "authenticated" : `not set up — ${t.loginHint}`}\n`,
        );
      }
    });

  // ---------------------------------------------------------------------------
  // secrets — audit what auth/credentials were transmitted to a session
  // ---------------------------------------------------------------------------

  const secretsCommand = program
    .command("secrets")
    .description("Audit the credentials transmitted to remote sessions");

  secretsCommand
    .command("status [sessionId]")
    .description(
      "Show what auth/credentials each remote session received (live k8s Secret, key names only — values are never shown). Pass a sessionId for per-file detail.",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (sessionId: string | undefined, opts: { remote?: string }) => {
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);

      if (sessionId) {
        const entries = transmittedSecrets(sessionId);
        if (entries === undefined) {
          process.stdout.write(
            `[remote] cannot read secrets for ${sessionId} (no tunnel configured, or no auth Secret)\n`,
          );
          return;
        }
        process.stdout.write(`Secrets transmitted to ${sessionId} (live, names only):\n`);
        if (entries.length === 0) {
          process.stdout.write("  (none)\n");
          return;
        }
        for (const e of entries) {
          process.stdout.write(
            `  ${e.path}${e.tool !== "?" ? `  [${e.tool}]` : ""}${e.broad ? "  ⚠ account-wide cloud credential" : ""}\n`,
          );
        }
        const broad = entries.filter((e) => e.broad).map((e) => e.tool);
        if (broad.length > 0) {
          process.stdout.write(
            `\n⚠ broad cloud credentials sent: ${[...new Set(broad)].join(", ")} — revoke by re-deporting without them (--with) if unintended.\n`,
          );
        }
        return;
      }

      const sessions = await listRemoteSessions(url);
      process.stdout.write(`Transmitted secrets per project @ ${url}:\n`);
      if (sessions.length === 0) {
        process.stdout.write("  (none)\n");
        return;
      }
      for (const s of sessions) {
        process.stdout.write(
          `  ${projectName(s).padEnd(22)} ${secretsSummary(s.id)}   (${s.id})\n`,
        );
      }
      process.stdout.write(
        "\n(⚠ = account-wide cloud cred. Detail: remote secrets status <sessionId>.)\n",
      );
    });

  // ---------------------------------------------------------------------------
  // diff — is the remote session aligned with the local one?
  // ---------------------------------------------------------------------------

  program
    .command("diff [sessionId]")
    .description(
      "Check whether each remote session is in sync with local — conversation log by default (--session), or git workspace state with --files (metrics/names only — content never transferred)",
    )
    .option("--session", "compare conversation logs (default)")
    .option(
      "--files",
      "compare the git state of the workspace instead: HEAD, branch, modified file names (local cwd vs Pod $WORKSPACE_PATH)",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(
      async (
        sessionId: string | undefined,
        opts: { session?: boolean; files?: boolean; remote?: string },
      ) => {
        if (opts.session && opts.files) {
          process.stderr.write("[remote] --session and --files are mutually exclusive\n");
          process.exitCode = 1;
          return;
        }
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        const all = await listRemoteSessions(url);
        const sessions = sessionId ? all.filter((s) => s.id === sessionId) : all;
        if (sessions.length === 0) {
          process.stdout.write("[remote] no matching session\n");
          return;
        }
        const icon: Record<string, string> = {
          "in-sync": "✓ in-sync   ",
          "local-ahead": "↑ local-ahead",
          "remote-ahead": "↓ remote-ahead",
          diverged: "⚠ diverged  ",
          missing: "· n/a       ",
        };
        for (const s of sessions) {
          if (!s.workspacePath) {
            process.stdout.write(`  ${projectName(s)}: no workspace path\n`);
            continue;
          }
          if (opts.files) {
            const local = localGitStat(s.workspacePath);
            const remote = remoteGitStat(s.id);
            const ancestry =
              local && remote && local.head !== remote.head
                ? localAncestry(s.workspacePath, local.head, remote.head)
                : "unknown";
            const v = gitAlignment(local, remote, ancestry);
            process.stdout.write(
              `${(icon[v.state] ?? v.state).padEnd(14)} ${projectName(s).padEnd(18)} ${v.detail}\n`,
            );
            continue;
          }
          const local = localConvStat(s.workspacePath);
          const remote = remoteConvStat(s.id, s.workspacePath);
          const v = alignment(local, remote);
          process.stdout.write(
            `${(icon[v.state] ?? v.state).padEnd(14)} ${projectName(s).padEnd(18)} ${v.detail}\n`,
          );
        }
      },
    );

  // ---------------------------------------------------------------------------
  // sync — copy the conversation log between local and the session Pod
  // ---------------------------------------------------------------------------

  program
    .command("sync <sessionId>")
    .description(
      "Copy the conversation log between local and the session Pod (base64 over kubectl exec — content never printed). Guarded: refuses to overwrite the side that is ahead without --force; the overwritten file is backed up as .bak-<epoch> first.",
    )
    .option(
      "--session <direction>",
      "conversation sync direction: pull (Pod → local) or push (local → Pod)",
    )
    .option("--files", "not automated — use git on both sides")
    .option("--force", "override the ahead-guard (a backup is still taken)")
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(
      async (
        sessionId: string,
        opts: { session?: string; files?: boolean; force?: boolean; remote?: string },
      ) => {
        if (opts.files) {
          process.stderr.write(
            "[remote] files: utilise git (commit/push des deux côtés) — non automatisé\n",
          );
          process.exitCode = 1;
          return;
        }
        if (opts.session !== "push" && opts.session !== "pull") {
          process.stderr.write(
            "[remote] usage: remote sync <sessionId> --session <push|pull>\n",
          );
          process.exitCode = 1;
          return;
        }
        const direction: SyncDirection = opts.session;
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        const session = (await listRemoteSessions(url)).find((s) => s.id === sessionId);
        if (!session?.workspacePath) {
          process.stderr.write(
            `[remote] no session ${sessionId} with a workspace path\n`,
          );
          process.exitCode = 1;
          return;
        }
        const result = syncConversation({
          sessionId,
          workspacePath: session.workspacePath,
          direction,
          force: opts.force ?? false,
        });
        if (!result.ok) {
          process.stderr.write(`[remote] refused: ${result.reason}\n`);
          process.exitCode = 1;
          return;
        }
        if (result.backup) {
          process.stderr.write(`[remote] backup: ${result.backup}\n`);
        }
        const lines = direction === "pull" ? result.lines.remote : result.lines.local;
        process.stderr.write(
          `[remote] ${direction === "pull" ? "pulled" : "pushed"} ${result.convId} (${lines} lines) → ${result.written}\n`,
        );
        if (direction === "push") {
          process.stderr.write(
            `[remote] not relaunching the Pod CLI — relance la session pour charger : remote refresh ${sessionId} --soft\n`,
          );
        }
      },
    );

  // ---------------------------------------------------------------------------
  // forward — expose a Pod port locally (UAT/UI control via kubectl port-forward)
  // ---------------------------------------------------------------------------

  program
    .command("forward <sessionId> <podPort> [localPort]")
    .description(
      "Expose a port of a session Pod on localhost via kubectl port-forward — reach a web UI running in the Pod (UAT/mail control, dev server) at http://localhost:<localPort>. Foreground until Ctrl-C.",
    )
    .option("--address <addr>", "local bind address (default 127.0.0.1)")
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(
      async (
        sessionId: string,
        podPort: string,
        localPort: string | undefined,
        opts: { address?: string; remote?: string },
      ) => {
        const port = Number(podPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          process.stderr.write(`[remote] invalid pod port "${podPort}"\n`);
          process.exitCode = 1;
          return;
        }
        let local: number | undefined;
        if (localPort !== undefined) {
          local = Number(localPort);
          if (!Number.isInteger(local) || local < 1 || local > 65535) {
            process.stderr.write(`[remote] invalid local port "${localPort}"\n`);
            process.exitCode = 1;
            return;
          }
        }
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        process.exitCode = await forwardSessionPort({
          sessionId,
          podPort: port,
          remoteUrl: url,
          ...(local !== undefined ? { localPort: local } : {}),
          ...(opts.address !== undefined ? { address: opts.address } : {}),
        });
      },
    );

  // ---------------------------------------------------------------------------
  // browser — WP7 noVNC headful browser-in-pod (2FA / authenticated sites)
  // ---------------------------------------------------------------------------

  const browserCommand = program
    .command("browser")
    .description(
      "Open a headful browser running INSIDE a session Pod (noVNC) to complete a 2FA / login challenge visually.",
    );

  browserCommand
    .command("open <sessionId>")
    .description(
      "Print the steps to open the headful browser view for a session: the " +
        "`remote forward` command to run and the token-gated noVNC URL to open. " +
        "Default exposure is session-private (owner only, token-gated) and interactive (you drive the 2FA).",
    )
    .option("--local-port <port>", "local port to bind the forward to")
    .option(
      "--policy <policy>",
      "uat exposure policy: operator-only | session-private | public-expiring (default session-private)",
    )
    .option(
      "--ttl <ms>",
      "route TTL in ms (required for the public-expiring policy)",
    )
    .option("--view-only", "open a read-only mirror (cannot complete 2FA)")
    .action(
      (
        sessionId: string,
        opts: {
          localPort?: string;
          policy?: string;
          ttl?: string;
          viewOnly?: boolean;
        },
      ) => {
        let localPort: number | undefined;
        if (opts.localPort !== undefined) {
          localPort = Number(opts.localPort);
          if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
            process.stderr.write(
              `[remote] invalid local port "${opts.localPort}"\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        const policy = opts.policy;
        if (
          policy !== undefined &&
          policy !== "operator-only" &&
          policy !== "session-private" &&
          policy !== "public-expiring"
        ) {
          process.stderr.write(
            `[remote] invalid --policy "${policy}" (operator-only | session-private | public-expiring)\n`,
          );
          process.exitCode = 1;
          return;
        }
        let ttlMs: number | undefined;
        if (opts.ttl !== undefined) {
          ttlMs = Number(opts.ttl);
          if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            process.stderr.write(`[remote] invalid --ttl "${opts.ttl}"\n`);
            process.exitCode = 1;
            return;
          }
        }
        const plan = buildBrowserOpenPlan({
          sessionId,
          ...(policy !== undefined ? { exposurePolicy: policy } : {}),
          ...(localPort !== undefined ? { localPort } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(opts.viewOnly ? { interactive: false } : {}),
        });
        if (!plan.ok) {
          process.stderr.write(`[remote] ${plan.reason}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(plan.instructions);
      },
    );

  // ---------------------------------------------------------------------------
  // migrate
  // ---------------------------------------------------------------------------

  const migrateCommand = program
    .command("migrate")
    .description(
      "Round-trip a local CLI session to a remote (SCW k8s) session and back",
    );

  migrateCommand
    .command("forward <profile>")
    .description(
      "Migrate the current terminal session to a remote k8s session for <profile>. " +
        "Links the cwd to a workspace (or reuses the existing one), pushes project files, " +
        "creates a remote session, and hands off this terminal to it. " +
        "Press Ctrl+P Ctrl+Q to detach without stopping the remote session.",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .option(
      "--workspace <id>",
      "workspace id to bind (defaults to .remote/workspace.json or creates a new workspace)",
    )
    .option(
      "-r, --resume [convId]",
      "resume the most recent (or a specific) conversation on the remote CLI",
    )
    .option(
      "--no-attach",
      "create the remote session without hijacking this terminal; print the attach command instead (for bulk migration / reconnecting your own terminal)",
    )
    .option(
      "--reconnect",
      "revive a session on the EXISTING workspace without re-pushing files (preserves work done remotely) — use after an accidental exit (Ctrl+C/Ctrl+D) to bring the session back from its retained PVC with path parity + --resume",
    )
    .option(
      "--with <tools>",
      `comma-separated tool CLIs whose local auth to also bundle into the Pod (known: ${KNOWN_TOOLS.join(", ")}); defaults to 'remote config tools'`,
    )
    .option(
      "--force",
      "migrate even if the conversation already has a live writer (risk: conversation .jsonl corruption)",
    )
    .action(
      async (
        profile: string,
        opts: {
          remote?: string;
          workspace?: string;
          resume?: string | true;
          attach?: boolean;
          reconnect?: boolean;
          with?: string;
          force?: boolean;
        },
      ) => {
        const remoteUrl = getConfiguredRemote(opts.remote);
        await ensureConnected(remoteUrl);
        // Single-writer guard: the conversation must not stay open locally (or
        // in another pod) while we deport it — stop the local session first
        // (`remote stop <slug>`), or --force to take over anyway. A BARE -r
        // resumes "the most recent conversation", resolved inside
        // migrateForward AFTER this point — so resolve the same newest local
        // conversation HERE (localConvStat on the cwd; claude-family only,
        // it reads ~/.claude/projects) and guard it exactly like an explicit
        // convId. No local conversation → nothing to guard (unchanged).
        const guardConvId =
          typeof opts.resume === "string"
            ? opts.resume
            : opts.resume === true &&
                coerceCliProfileName(profile) === "claude"
              ? localConvStat(process.cwd())?.convId
              : undefined;
        if (guardConvId !== undefined) {
          const ok = await guardConvWriters({
            convId: guardConvId,
            cwd: process.cwd(),
            ...(opts.force ? { force: true } : {}),
            fetchRemoteSessions: () => listRemoteSessions(remoteUrl),
          });
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }
        const tools = resolveTools(opts.with);
        await migrateForward({
          profile,
          remoteUrl,
          ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          // commander sets opts.attach=false for --no-attach (default true).
          ...(opts.attach === false ? { noAttach: true } : {}),
          ...(opts.reconnect ? { reconnect: true } : {}),
          ...(tools.length > 0 ? { tools } : {}),
        });
      },
    );

  migrateCommand
    .command("ls")
    .description(
      "List local CLI sessions that can be migrated (claude conversations under ~/.claude/projects)",
    )
    .action(() => {
      const now = Date.now();
      const candidates = listMigrationCandidates();
      if (candidates.length === 0) {
        process.stdout.write(
          "[remote] no local claude sessions found under ~/.claude/projects\n",
        );
        return;
      }
      process.stdout.write("#    AGE    SIZE    CONVS  GIT  MIGRATED  PATH\n");
      candidates.forEach((c, i) => {
        const n = String(i + 1).padEnd(4);
        const age = humanAge(c.lastActivity, now).padEnd(6);
        const size = humanSize(c.sizeBytes).padEnd(7);
        const convs = String(c.convCount).padEnd(6);
        const git = (c.isGit ? "yes" : "no").padEnd(4);
        const mig = (c.linked ? "yes" : "no").padEnd(9);
        const missing = c.exists ? "" : "  (dir missing)";
        process.stdout.write(
          `${n} ${age} ${size} ${convs} ${git} ${mig} ${c.path}${missing}\n`,
        );
      });
      process.stdout.write(
        "\nMigrate one: cd <path> && remote migrate forward claude --resume\n" +
          "Pick interactively: remote migrate pick\n",
      );
    });

  migrateCommand
    .command("pick")
    .description(
      "Interactively select which local sessions to migrate to the remote cluster (git repos only)",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option("--profile <profile>", "CLI profile to start remotely", "claude")
    .option("--no-resume", "do not resume the conversation on the remote CLI")
    .option(
      "--with <tools>",
      `comma-separated tool CLIs whose auth to bundle (known: ${KNOWN_TOOLS.join(", ")}); defaults to 'remote config tools'`,
    )
    .action(
      async (opts: {
        remote?: string;
        profile?: string;
        resume?: boolean;
        with?: string;
      }) => {
        const remoteUrl = getConfiguredRemote(opts.remote);
        await ensureConnected(remoteUrl);
        const profile = opts.profile ?? "claude";
        const tools = resolveTools(opts.with);
        const now = Date.now();
        const candidates = listMigrationCandidates().filter(
          (c) => c.exists && c.isGit,
        );
        if (candidates.length === 0) {
          process.stdout.write(
            "[remote] no migratable git-backed sessions found\n",
          );
          return;
        }
        process.stdout.write("Local sessions you can migrate:\n\n");
        candidates.forEach((c, i) => {
          const age = humanAge(c.lastActivity, now).padStart(4);
          const size = humanSize(c.sizeBytes).padStart(6);
          const tag = c.linked ? " [already migrated]" : "";
          process.stdout.write(
            `  ${String(i + 1).padStart(2)}) ${age} ago  ${size}  ${c.path}${tag}\n`,
          );
        });
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            "\nNumbers to migrate (e.g. 1,3,5 — empty to cancel): ",
            resolve,
          );
        });
        rl.close();
        const chosen = answer
          .split(/[\s,]+/)
          .map((s) => Number.parseInt(s, 10))
          .filter(
            (n) => Number.isInteger(n) && n >= 1 && n <= candidates.length,
          )
          .map((n) => candidates[n - 1]!);
        if (chosen.length === 0) {
          process.stdout.write("[remote] nothing selected — cancelled\n");
          return;
        }
        for (const c of chosen) {
          process.stdout.write(`\n=== migrating ${c.path} ===\n`);
          try {
            await migrateForward({
              profile,
              remoteUrl,
              cwd: c.path,
              ...(opts.resume === false ? {} : { resume: true }),
              noAttach: true,
              ...(tools.length > 0 ? { tools } : {}),
            });
          } catch (err) {
            process.stderr.write(
              `[remote] failed to migrate ${c.path}: ${String(err)}\n`,
            );
          }
        }
      },
    );

  migrateCommand
    .command("back")
    .description(
      "Pull the remote workspace and conversation state back to local, stop the remote session, " +
        "and print the command to resume the CLI locally. Does NOT spawn the local CLI.",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .option(
      "--workspace <id>",
      "workspace id to pull (defaults to .remote/workspace.json)",
    )
    .option(
      "--on-conflict <mode>",
      "conflict resolution for diverged conversations: backup | keep-local (default: block)",
    )
    .action(
      async (opts: {
        remote?: string;
        workspace?: string;
        onConflict?: string;
      }) => {
        const remoteUrl = getConfiguredRemote(opts.remote);
        const onConflict =
          opts.onConflict === "backup"
            ? ("backup" as const)
            : opts.onConflict === "keep-local"
              ? ("keep-local" as const)
              : ("block" as const);
        await migrateBack({
          remoteUrl,
          ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
          onConflict,
        });
      },
    );

  // ---------------------------------------------------------------------------
  // plugin — npm packages providing a CLI + an MCP server, for all agent CLIs
  // ---------------------------------------------------------------------------

  const pluginCommand = program
    .command("plugin")
    .description(
      "Install npm plugin packages (CLI + MCP server, e.g. @sentropic/track) for the agent CLIs — locally and in live remote session Pods",
    );

  pluginCommand
    .command("add <pkgOrName>")
    .description(
      "Register a plugin propagated to sessions. npm (default): `npm i -g <pkg>` + register its MCP server(s) with claude + codex + agy. " +
        "--curl <url> / --install \"<shell>\": a NON-npm tool, installed in each Pod on sync by piping an https script or running a shell command (e.g. a Go binary's install.sh). " +
        "Without --mcp, every npm bin ending in -mcp is registered (track-mcp -> track), as `node <realpath>`.",
    )
    .option(
      "--mcp <name=bin>",
      "MCP server to register, as <name>=<bin> (repeatable; overrides the -mcp heuristic)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option("--curl <url>", "install in Pods via `curl -fsSL <url> | bash` (non-npm)")
    .option("--install <shell>", "install in Pods by running this shell command (non-npm)")
    .action(
      (
        pkgOrName: string,
        opts: { mcp: string[]; curl?: string; install?: string },
      ) => {
        if (opts.curl !== undefined && opts.install !== undefined) {
          process.stderr.write("[remote] pass only one of --curl / --install\n");
          process.exitCode = 1;
          return;
        }
        if (opts.curl !== undefined) {
          pluginAddInstaller(pkgOrName, { method: "curl", spec: opts.curl });
        } else if (opts.install !== undefined) {
          pluginAddInstaller(pkgOrName, { method: "script", spec: opts.install });
        } else {
          pluginAdd(pkgOrName, opts.mcp);
        }
      },
    );

  pluginCommand
    .command("ls")
    .description(
      "List configured plugins: pkg, version, MCP servers, and where they are installed (local ok / remote ?)",
    )
    .action(() => {
      pluginLs();
    });

  pluginCommand
    .command("sync")
    .description(
      "Install every configured plugin into each live REMOTE session Pod (kubectl exec -> npm i -g) and register its MCP servers for the Pod's profile (claude/codex; others: TODO). Needs the configured tunnel.",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (opts: { remote?: string }) => {
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      await pluginSync(url);
    });

  pluginCommand
    .command("sync-skills")
    .description(
      "Copy the LOCAL Claude Code skills + plugin cache into live session Pod(s) so remote claude sessions get the same capabilities. " +
        "Whitelist ONLY (relative to $HOME): .claude/skills, .claude/plugins/{installed_plugins.json,marketplaces,cache} — NEVER auth/settings/transcripts. " +
        "tar -> kubectl exec -i -> untar (argv only, archive on stdin); idempotent (overwrites in place). Needs the configured tunnel.",
    )
    .option("--pod <name>", "sync a single session (by id or session-<id>)")
    .option("--all", "sync every live session Pod")
    .option("--dry-run", "print the tar/exec plan; transfer nothing")
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (opts: { pod?: string; all?: boolean; dryRun?: boolean; remote?: string }) => {
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      const syncOpts: { pod?: string; all?: boolean; dryRun?: boolean } = {};
      if (opts.pod !== undefined) syncOpts.pod = opts.pod;
      if (opts.all !== undefined) syncOpts.all = opts.all;
      if (opts.dryRun !== undefined) syncOpts.dryRun = opts.dryRun;
      await syncSkills(url, syncOpts);
    });

  program
    .command("run <profile> [path]")
    .description(
      "Start a LOCAL session in tmux (claude/codex/…) in <path> (default: cwd). Manage it like a remote one: `remote ls`, `remote attach <slug>`, `remote stop <slug>`. Detach with Ctrl-b d; the session keeps running.",
    )
    .option("--attach", "attach immediately after starting (default: start detached)")
    .option("-r, --resume <convId>", "resume a specific conversation in the CLI")
    .option(
      "--force",
      "start even if the conversation already has a live writer (risk: conversation .jsonl corruption)",
    )
    .option(
      "--name <label>",
      "tmux session slug + tab label (default: workdir basename); use to keep multiple sessions of one project distinct",
    )
    .option(
      "--count <n>",
      "fan out N parallel agents (named <base>#1…#N) — run more than the per-project layout cap of claude/codex sessions",
    )
    .option(
      "--h2a",
      "also start the h2a MCP server in a side tmux window \"h2a\" (launcher contract: agent reachable/wakeable via ~/h2a-workspace/.h2a); config key `h2a: {enabled, command}` makes it the default",
    )
    .action(
      async (
        profile: string,
        path: string | undefined,
        opts: {
          attach?: boolean;
          resume?: string;
          force?: boolean;
          name?: string;
          count?: string;
          h2a?: boolean;
        },
      ) => {
        if (!tmuxAvailable()) {
          process.stderr.write(
            "[remote] tmux is not installed locally — `remote run` needs it (e.g. `sudo apt install tmux`).\n",
          );
          process.exitCode = 1;
          return;
        }
        let count = 1;
        if (opts.count !== undefined) {
          count = Number(opts.count);
          if (!Number.isInteger(count) || count < 1) {
            process.stderr.write(`[remote] --count must be a whole number ≥ 1\n`);
            process.exitCode = 1;
            return;
          }
          // Fanning out N agents on the SAME conversation = N writers on one
          // .jsonl (corruption). A fan-out is N FRESH conversations.
          if (count > 1 && opts.resume) {
            process.stderr.write(
              `[remote] --count > 1 cannot combine with -r/--resume (each fanned agent is a fresh conversation; resuming one into N would corrupt it)\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        const cwd = path ? resolve(path) : process.cwd();
        // Single-writer guard: refuse to resume a conversation another live
        // session (local registry / remote pod) is already writing.
        if (opts.resume) {
          const ok = await guardConvWriters({
            convId: opts.resume,
            cwd,
            ...(opts.force ? { force: true } : {}),
            fetchRemoteSessions: async () => {
              const url = getConfiguredRemoteOptional();
              return url ? await listRemoteSessions(url) : [];
            },
          });
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        }
        const command = localCliCommand(profile);
        const args = opts.resume ? localResumeArgs(profile, opts.resume) : [];
        const h2a = getH2aConfig();
        // count==1 keeps the exact prior behaviour (label = opts.name, which may
        // be undefined → slug derives from cwd). count>1 fans out distinct
        // labels <base>#k from the name or the cwd basename.
        const labels: Array<string | undefined> =
          count > 1
            ? fanoutLabels(opts.name ?? basename(cwd), count)
            : [opts.name];
        const started: Array<{ name: string; slug: string }> = [];
        for (const label of labels) {
          const { name, slug } = startLocalSession(
            profile,
            command,
            cwd,
            args,
            label,
          );
          // Auto-enroll in the live-session registry (feeds `remote ls`/`restore`).
          enrollFromRun({
            profile,
            slug,
            tmuxSession: name,
            cwd,
            ...(opts.resume !== undefined ? { convId: opts.resume } : {}),
          });
          started.push({ name, slug });
          // h2a launcher contract (opt-in): --h2a forces it; `h2a.enabled` makes
          // it the default. Never fails the run.
          if (opts.h2a || h2a.enabled) {
            if (startH2aWindow(name, cwd, h2a.command)) {
              process.stderr.write(
                `[remote] h2a window started in ${slug} (${h2a.command})\n`,
              );
            }
          }
        }
        if (count > 1) {
          process.stderr.write(
            `[remote] ${started.length} ${profile} agents started in ${cwd}: ${started.map((s) => s.slug).join(", ")}\n` +
              `[remote] attach one with: remote attach <slug>\n`,
          );
          return; // never auto-attach a fleet
        }
        const only = started[0]!;
        process.stderr.write(
          `[remote] local session ${only.slug} started (${profile}${opts.resume ? ` --resume ${opts.resume}` : ""} in ${cwd})\n`,
        );
        if (opts.attach) {
          attachLocalSession(only.name);
          return;
        }
        process.stderr.write(`[remote] attach with: remote attach ${only.slug}\n`);
      },
    );

  // ---------------------------------------------------------------------------
  // delegate — spawn a cross-type agent (claude/codex/agy) as a LOCAL job (P1)
  // ---------------------------------------------------------------------------

  program
    .command("delegate <type> <task>")
    .description(
      "Delegate a task to a LIVE agent (claude/codex/agy) in a detached tmux session, primed with <task> (passed as a single argv — never shell-concatenated) and with the h2a side-window so the parent/master dialogue works. Returns a job id. Supervise with `remote jobs`; drain the queue with `remote jobs conduct`. `--remote` runs the job CONCURRENTLY in a SCW Pod on the shared RWX volume (subPath per job). Beyond the concurrency cap (default 16) the job is QUEUED (pending) and started by the conductor as slots free.",
    )
    .option(
      "--remote [url]",
      "run the job in a SCW Pod (concurrent; isolated by a per-job workspace subPath on the shared RWX volume) instead of a local tmux session; optional control-plane URL (default: the configured remote)",
    )
    .option(
      "--cwd <path>",
      "run the agent in this directory as-is (default: a dedicated git worktree under .remote/jobs/<id>/wt when cwd is a repo, else cwd). Local only.",
    )
    .option(
      "--name <label>",
      "job id / tmux slug (letters/digits/_/-; default: <type>-<random>)",
    )
    .option(
      "--headless",
      "run-once-exit batch mode: claude -p / codex exec, stdout→output.log, write result.json, then END the session (no live agent; agy has no headless mode)",
    )
    .option(
      "--on-done <h2a-instance>",
      "h2a instance to notify with a `job.done` envelope when the job ends, and the parent for the decision channel (e.g. claude:remote:abc / claude:job:foo). Alias: --parent.",
    )
    .option(
      "--parent <h2a-instance>",
      "alias of --on-done: the delegating parent's h2a instance (callback + decision recipient)",
    )
    .option(
      "--max-concurrent <n>",
      "concurrency cap for this delegation decision (default: config maxConcurrent / REMOTE_MAX_CONCURRENT / 16). Beyond `running` jobs at the cap, this job is QUEUED (pending).",
    )
    .option(
      "--max-depth <d>",
      "spawn-depth budget granted to this job (clamp 1–3, default 1, à la Hermes). A LOCAL job inherits a DECREMENTED budget via REMOTE_DELEGATE_DEPTH; at 0 a nested `delegate` refuses. With --remote the budget is clamped to 1 (no env channel reaches the Pod yet → a job-in-a-Pod does not re-delegate).",
    )
    .option(
      "--track <wpId>",
      "mirror this job as a track item under workpackage <wpId> (`track item new --parent`, realized on done/failed). Best-effort: skipped silently if track is absent.",
    )
    .action(
      async (
        type: string,
        task: string,
        opts: {
          remote?: string | boolean;
          cwd?: string;
          name?: string;
          headless?: boolean;
          onDone?: string;
          parent?: string;
          maxConcurrent?: string;
          maxDepth?: string;
          track?: string;
        },
      ) => {
        if (!isDelegateType(type)) {
          process.stderr.write(
            `[remote] unknown agent type "${type}" (use: claude | codex | agy)\n`,
          );
          process.exitCode = 1;
          return;
        }
        const jobType: DelegateType = type;
        const jobId = opts.name ?? `${jobType}-${Math.random().toString(36).slice(2, 8)}`;
        // Parent h2a instance to notify on done + answer decisions (best-effort).
        const callbackTo = opts.onDone ?? opts.parent;
        try {
          assertSafeName(jobId);
        } catch (err) {
          process.stderr.write(`[remote] ${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }

        // --- Spawn-depth guard (P4). A `delegate` invoked FROM a job inherits a
        // budget via REMOTE_DELEGATE_DEPTH; at 0 it must refuse (runaway-tree
        // guard, à la Hermes max_spawn_depth). Top-level: the requested
        // --max-depth (clamped 1–3) is the budget.
        const requestedDepth =
          opts.maxDepth !== undefined ? Number.parseInt(opts.maxDepth, 10) : undefined;
        const depthBudget = inheritedDepthBudget(requestedDepth, process.env);
        if (!canDelegateAtDepth(depthBudget)) {
          process.stderr.write(
            "[remote] spawn-depth budget exhausted (REMOTE_DELEGATE_DEPTH=0) — this job has reached its --max-depth and may not delegate further.\n",
          );
          process.exitCode = 1;
          return;
        }

        // --- Concurrency cap (P4). The cap applies to BOTH local and remote
        // (shared RWX is multi-node; no CSI packing limit). Beyond `running`
        // jobs at the cap, ENQUEUE the job (jobState:"pending") instead of
        // launching it; the conductor (`remote jobs conduct`) starts it later.
        const cap =
          opts.maxConcurrent !== undefined
            ? Number.parseInt(opts.maxConcurrent, 10)
            : getMaxConcurrent() ?? DEFAULT_MAX_CONCURRENT;
        const effectiveCap =
          Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_CONCURRENT;

        const isRemote = opts.remote !== undefined && opts.remote !== false;
        // REMOTE depth clamp: no env channel reaches the Pod (see
        // clampRemoteDepthBudget), so a remote job can't enforce a budget > 1 →
        // record AT MOST 1 (a job-in-a-Pod doesn't re-delegate). Local keeps 1–3.
        const recordedDepthBudget = isRemote
          ? clampRemoteDepthBudget(depthBudget)
          : depthBudget;
        let remoteTarget: string | undefined;
        if (isRemote) {
          try {
            remoteTarget = getConfiguredRemote(
              typeof opts.remote === "string" ? opts.remote : undefined,
            );
          } catch (err) {
            process.stderr.write(`[remote] ${(err as Error).message}\n`);
            process.exitCode = 1;
            return;
          }
        } else if (!tmuxAvailable()) {
          process.stderr.write(
            "[remote] tmux is not installed locally — local `remote delegate` needs it (use --remote for a Pod).\n",
          );
          process.exitCode = 1;
          return;
        }

        // Enroll the job FIRST as `pending`, carrying the full queued-launch spec
        // so the conductor can launch it later from the registry alone. Reuses
        // the atomic write. Best-effort: a registry hiccup must not crash the CLI.
        const explicitCwd =
          !isRemote && opts.cwd !== undefined ? resolve(opts.cwd) : undefined;
        try {
          enroll({
            id: jobId,
            tool: jobType,
            kind: isRemote ? "remote" : "local-tmux",
            cwd: isRemote ? `job-${jobId}` : process.cwd(),
            source: isRemote ? "remote" : "run",
            label: jobId,
            role: "job",
            jobState: "pending",
            task,
            headless: opts.headless === true,
            originCwd: process.cwd(),
            depthBudget: recordedDepthBudget,
            ...(remoteTarget !== undefined ? { remoteTarget } : {}),
            ...(explicitCwd !== undefined ? { explicitCwd } : {}),
            ...(callbackTo !== undefined ? { callbackTo } : {}),
            ...(opts.track !== undefined ? { trackWp: opts.track } : {}),
          });
        } catch {
          // registry hiccup must not break the delegation
        }

        // S3 — ATOMICALLY claim a slot: the cap check + the enroll-as-running
        // happen under ONE registry lock, so two concurrent `delegate`s can never
        // both see the same free slot and overshoot the cap. A null claim means
        // the cap is full → the job stays `pending` (queued) for the conductor.
        const claimInput = {
          id: jobId,
          tool: jobType,
          kind: (isRemote ? "remote" : "local-tmux") as RegistryEntry["kind"],
          cwd: isRemote ? `job-${jobId}` : process.cwd(),
          source: (isRemote ? "remote" : "run") as RegistryEntry["source"],
          label: jobId,
          role: "job" as const,
          task,
          headless: opts.headless === true,
          originCwd: process.cwd(),
          depthBudget: recordedDepthBudget,
          ...(remoteTarget !== undefined ? { remoteTarget } : {}),
          ...(explicitCwd !== undefined ? { explicitCwd } : {}),
          ...(callbackTo !== undefined ? { callbackTo } : {}),
          ...(opts.track !== undefined ? { trackWp: opts.track } : {}),
        };
        let claimed: RegistryEntry | undefined;
        try {
          claimed = tryClaimSlot(claimInput, effectiveCap);
        } catch {
          // registry hiccup: fall through to an in-memory launch below
          claimed = undefined;
        }
        if (!claimed && listJobs().some((e) => e.id === jobId)) {
          // The entry exists but the cap is full → stay queued.
          process.stderr.write(
            `[remote] queued job ${jobId} (${jobType}${opts.headless ? " headless" : ""}${isRemote ? " remote" : ""}) — ` +
              `${effectiveCap} concurrent slot(s) busy. Start it with: remote jobs conduct\n`,
          );
          process.stdout.write(`${jobId}\n`);
          return;
        }
        if (!claimed) {
          // Registry write failed entirely (no entry at all) — fall back to a
          // throwaway in-memory entry so the launch still happens.
          process.stderr.write(
            `[remote] job ${jobId} not in registry after enroll — launching from an in-memory spec\n`,
          );
        }
        const launchEntry: RegistryEntry =
          claimed ??
          ({
            id: jobId,
            tool: jobType,
            kind: isRemote ? "remote" : "local-tmux",
            cwd: process.cwd(),
            enrolledAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            source: isRemote ? "remote" : "run",
            role: "job",
            jobState: "running",
            task,
            headless: opts.headless === true,
            originCwd: process.cwd(),
            depthBudget: recordedDepthBudget,
            ...(remoteTarget !== undefined ? { remoteTarget } : {}),
            ...(explicitCwd !== undefined ? { explicitCwd } : {}),
            ...(callbackTo !== undefined ? { callbackTo } : {}),
            ...(opts.track !== undefined ? { trackWp: opts.track } : {}),
          } satisfies RegistryEntry);

        const result = await startJob(launchEntry);
        if (!result.started) {
          // The slot was claimed `running` (S3) but the launch failed — release
          // it so it doesn't occupy a slot forever (conductor would otherwise
          // only reclaim it on a later reconcile pass).
          if (claimed) advanceJob(jobId, "failed");
          process.stderr.write(`[remote] failed to start job ${jobId}: ${result.error}\n`);
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          `[remote] delegated ${result.target === "remote" ? "REMOTE " : ""}job ${jobId} (${jobType}${opts.headless ? " headless" : ""}) ${result.target === "remote" ? "→ " : "in "}${result.detail}\n` +
            `[remote] supervise: remote jobs status ${jobId}` +
            (opts.headless ? "" : `   attach: remote jobs attach ${jobId}`) +
            "\n",
        );
        process.stdout.write(`${jobId}\n`);
      },
    );

  // ---------------------------------------------------------------------------
  // jobs — supervise delegated jobs (ls / status / attach / logs)
  // ---------------------------------------------------------------------------

  const jobsCommand = program
    .command("jobs")
    .description("Supervise delegated agent jobs (see `remote delegate`).");

  const jobLive = (e: ReturnType<typeof listJobs>[number]): boolean =>
    isLive(e);

  // S1 — resolve the `actor.instance` a job envelope MUST carry to be trusted,
  // off the registry: `job.done`/`decision.requested` (ABOUT the job) must come
  // FROM the job's own agent (jobInstance); `decision.reply` (FROM the parent)
  // must come from the job's recorded parent (callbackTo). Unknown job → undefined
  // → the envelope is rejected (fail closed). Used to drop forged cross-job
  // envelopes from the shared RWX inbox before they reach the decision logic.
  const expectedInstanceOf: ExpectedInstanceResolver = (jobId, type) => {
    const job = loadRegistry().find((e) => e.id === jobId && e.role === "job");
    if (!job) return undefined;
    if (type === "decision.reply") return parentInstance(job);
    return jobInstance(job);
  };
  /** Read the local inbox and AUTHENTICATE job envelopes (best-effort: [] on error). */
  const readAuthedInbox = () => {
    try {
      return authenticateJobEnvelopes(readInboxEnvelopes(), expectedInstanceOf);
    } catch {
      return [];
    }
  };

  // Best-effort: realize the track mirror item when a job reaches a terminal
  // state. Skipped silently when the job carries no `trackWp` or track is absent.
  const realizeTrackMirror = (job: RegistryEntry): void => {
    if (!job.trackWp) return;
    runTrackMirror(trackItemRealizeArgs({ id: job.id }), job.originCwd ?? process.cwd());
  };

  // Persist the terminal state of jobs whose runtime has ended:
  //  - LOCAL: a HEADLESS job that wrote a result.json reconciles to its real
  //    done/failed; any other dead-but-still-"running" job (interactive
  //    crashed/finished) reconciles to failed.
  //  - REMOTE (P2): the registry reports `kind:"remote"` as live ALWAYS (it
  //    can't probe the cluster), so we reconcile against `listRemoteSessions` —
  //    a remote job whose Pod is no longer listed has ended (→ result.json's
  //    state if present, else failed). Fetched ONCE, only when there is a
  //    non-terminal remote job; a control-plane hiccup must not break `jobs`.
  // Makes the registry the source of truth; the pure reconcilers are display
  // fallbacks. Returns the freshly-reloaded jobs.
  const reconcileJobs = async (): Promise<ReturnType<typeof listJobs>> => {
    // Local: tmux/pid liveness (no cluster call). On a terminal transition,
    // emit a best-effort `job.done` to the parent (headless/codex/agy + a
    // crashed interactive job). The claude SessionEnd hook covers the normal
    // interactive case; the file name is stable so a double-emit is a no-op.
    for (const job of listJobs()) {
      if (job.kind === "remote") continue;
      const state = job.jobState ?? "pending";
      // A `pending` job is QUEUED, not launched: it has no tmux session yet, so
      // its non-liveness must NOT be read as a crash. Leave it for the conductor.
      if (state === "pending" || state === "done" || state === "failed") continue;
      if (jobLive(job)) continue;
      // H2 — result.json was written under the job's ORIGIN cwd (HEADLESS_WRAPPER
      // → jobDir(originCwd)); a conductor running from a DIFFERENT cwd must read
      // it there, not at its own process.cwd() (which would always miss → force
      // `failed` on a successful exit). Same fix at every readJobResult site.
      const result = readJobResult(job.originCwd ?? process.cwd(), job.id);
      const advanced = advanceJob(job.id, result?.state ?? "failed");
      if (advanced) {
        emitJobDone(advanced, {
          state: advanced.jobState ?? "failed",
          ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        });
        realizeTrackMirror(advanced);
      }
    }
    // Remote: reconcile against the control-plane session list. Skip `pending`
    // (queued, no Pod yet) — only RUNNING remote jobs are checked against live.
    const remoteJobs = listJobs().filter(
      (j) =>
        j.kind === "remote" &&
        (j.jobState ?? "pending") === "running",
    );
    if (remoteJobs.length > 0) {
      try {
        const url = getConfiguredRemote();
        const live = await listRemoteSessions(url);
        const liveIds = new Set(live.map((s) => s.id));
        for (const t of reconcileRemoteJobs(remoteJobs, liveIds, (j) =>
          readJobResult(j.originCwd ?? process.cwd(), j.id),
        )) {
          const advanced = advanceJob(t.id, t.to);
          // Drop the callback into the LOCAL inbox; `h2a bridge` carries it to
          // the parent's Pod if the parent is remote (idempotent by file name).
          if (advanced) {
            emitJobDone(advanced, { state: advanced.jobState ?? t.to });
            realizeTrackMirror(advanced);
          }
        }
      } catch {
        // no remote configured / unreachable → leave remote jobs as-is
      }
    }
    // M2 — SWEEP: a backstop for jobs the liveness reconcile above could NOT
    // resolve (e.g. a remote job whose control-plane was unreachable, or a
    // no-pid local entry isLive optimistically trusts). A `running` job that is
    // NOT live, has NO result.json, and is older than the (generous, configurable)
    // max age is failed so it stops occupying a concurrency slot forever.
    const maxAgeMs = getJobMaxAgeHours() * 3600_000;
    for (const id of sweepStaleJobs(listJobs(), {
      isJobLive: jobLive,
      hasResult: (j) =>
        readJobResult(j.originCwd ?? process.cwd(), j.id) !== undefined,
      maxAgeMs,
    })) {
      const advanced = advanceJob(id, "failed");
      if (advanced) {
        emitJobDone(advanced, { state: "failed" });
        realizeTrackMirror(advanced);
      }
    }
    return listJobs();
  };

  jobsCommand
    .command("ls")
    .description(
      "List delegated jobs (id/type/state/age/cwd), live state reconciled against tmux (local) and the control-plane session list (remote).",
    )
    .action(async () => {
      const jobs = await reconcileJobs();
      const rows = buildJobRows(jobs, jobLive);
      process.stdout.write(`${renderJobsTable(rows)}\n`);
      // M3 — warn (don't self-heal) when queued jobs have no conductor draining.
      const advisory = conductorAdvisory(jobs, conductorRunning());
      if (advisory) process.stderr.write(`${advisory}\n`);
    });

  jobsCommand
    .command("status <id>")
    .description(
      "Show a job's detail (+ output.log / result.json paths for headless jobs).",
    )
    .action(async (id: string) => {
      await reconcileJobs();
      const job = listJobs().find((e) => e.id === id);
      if (!job) {
        process.stderr.write(`[remote] no job "${id}" (see: remote jobs ls)\n`);
        process.exitCode = 1;
        return;
      }
      const live = jobLive(job);
      // H2 — the job's artifacts (result.json/output.log) live under its ORIGIN
      // cwd, not the cwd `jobs status` happens to run from.
      const dir = jobDir(job.originCwd ?? process.cwd(), id);
      // awaiting-decision is a DISPLAY state (an unanswered decision.requested
      // for this job in the local h2a inbox), surfaced over the persisted state
      // for a still-running job. Best-effort: a missing/unreadable inbox is no
      // decision pending. Reads the inbox once.
      let displayState: string = job.jobState ?? "pending";
      if ((displayState === "running" || displayState === "pending") && live) {
        // Authenticate envelopes (S1): a forged decision.requested for this job
        // from a neighbour pod must not flip the display state.
        if (isAwaitingDecision(id, readAuthedInbox())) {
          displayState = "awaiting-decision";
        }
      }
      const lines = [
        `id:      ${job.id}`,
        `type:    ${job.tool}`,
        `target:  ${job.kind === "remote" ? "remote" : "local"}`,
        `state:   ${displayState}${live ? " (live)" : ""}`,
        `cwd:     ${job.cwd}`,
        job.kind === "remote"
          ? `session: ${job.remoteId ?? "-"}`
          : `tmux:    ${job.tmuxSession ?? "-"}`,
        `task:    ${job.task ?? "-"}`,
        `parent:  ${parentInstance(job) ?? "-"}`,
        `started: ${job.enrolledAt}`,
      ];
      const resultPath = join(dir, "result.json");
      const logPath = join(dir, "output.log");
      if (existsSync(resultPath)) lines.push(`result:  ${resultPath}`);
      if (existsSync(logPath)) lines.push(`output:  ${logPath}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  jobsCommand
    .command("attach <id>")
    .description(
      "Attach into the job's tmux session (Ctrl-b d to detach). Remote jobs exec into the Pod's tmux, like `remote attach <id> --exec`.",
    )
    .action(async (id: string) => {
      const job = listJobs().find((e) => e.id === id);
      // REMOTE job (P2): exec into the Pod's tmux over the configured tunnel,
      // reusing the same path as `remote attach <id> --exec`.
      if (job?.kind === "remote") {
        const remoteId = job.remoteId;
        if (!remoteId) {
          process.stderr.write(
            `[remote] remote job "${id}" has no session id recorded (see: remote jobs status ${id})\n`,
          );
          process.exitCode = 1;
          return;
        }
        const tunnel = getTunnel();
        if (!tunnel) {
          process.stderr.write(
            "[remote] attaching a remote job needs a tunnel configured (remote config tunnel …)\n",
          );
          process.exitCode = 1;
          return;
        }
        try {
          await ensureConnected(getConfiguredRemote());
        } catch {
          // best-effort: the kubectl exec below works off the tunnel regardless
        }
        process.stderr.write(
          `[remote] exec-attaching into Pod tmux for job ${id} (${remoteId}) (Ctrl-b d to detach)\n`,
        );
        process.exitCode = attachPodTmux(tunnel, remoteId);
        return;
      }
      // LOCAL job (P1): attach into the detached tmux session.
      const name = job?.tmuxSession ?? localSessionName(id);
      if (!findLocalSession(name)) {
        process.stderr.write(
          `[remote] no live tmux session for job "${id}" (it may have ended; see: remote jobs status ${id})\n`,
        );
        process.exitCode = 1;
        return;
      }
      attachLocalSession(name);
    });

  jobsCommand
    .command("logs <id>")
    .description(
      "Tail a job's output: output.log (headless) or the tmux pane capture (interactive).",
    )
    .action((id: string) => {
      const job = listJobs().find((e) => e.id === id);
      if (!job) {
        process.stderr.write(`[remote] no job "${id}" (see: remote jobs ls)\n`);
        process.exitCode = 1;
        return;
      }
      // H2 — output.log lives under the job's ORIGIN cwd, not this process's cwd.
      const logPath = join(jobDir(job.originCwd ?? process.cwd(), id), "output.log");
      if (existsSync(logPath)) {
        process.stdout.write(readFileSync(logPath, "utf8"));
        return;
      }
      // REMOTE job: the output lives in the Pod's tmux, not a local pane.
      if (job.kind === "remote") {
        process.stderr.write(
          `[remote] remote job "${id}" runs in a Pod — view it live with: remote jobs attach ${id}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const name = job.tmuxSession ?? localSessionName(id);
      const pane = capturePane(name);
      if (pane) {
        process.stdout.write(pane);
        return;
      }
      process.stderr.write(
        `[remote] no logs for job "${id}" (no output.log and the tmux pane is gone)\n`,
      );
      process.exitCode = 1;
    });

  // P3 — the decision channel (h2a). A delegated INTERACTIVE job can emit a
  // `decision.requested` envelope; the parent lists them here and answers with
  // `decide`. Both ride the local h2a inbox + `remote h2a bridge` to the Pod.
  jobsCommand
    .command("decisions")
    .description(
      "List unanswered `decision.requested` envelopes from delegated jobs (read from the local h2a inbox), with the asking job id and its question.",
    )
    .action(() => {
      // Authenticate first (S1): a forged decision.requested (wrong actor) for a
      // neighbour's job must not show up here, and a forged decision.reply must
      // not silently mark a real request answered.
      let envelopes;
      try {
        envelopes = authenticateJobEnvelopes(
          readInboxEnvelopes(),
          expectedInstanceOf,
        );
      } catch (error) {
        process.stderr.write(
          `[remote] cannot read the h2a inbox: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const replied = repliedDecisionJobIds(envelopes);
      const pending = pendingDecisions(envelopes, replied);
      process.stdout.write(`${renderPendingDecisions(pending)}\n`);
    });

  jobsCommand
    .command("decide <jobId> <answer>")
    .description(
      "Answer a job's `decision.requested`: write a `decision.reply` envelope into the job's h2a inbox (carried to its Pod by `remote h2a bridge`). <answer> is a single argv — never shell-concatenated.",
    )
    .option(
      "--from <h2a-instance>",
      "parent/master h2a instance to attribute the reply to (default: the job's recorded parent, else `remote:cli`)",
    )
    .action((jobId: string, answer: string, opts: { from?: string }) => {
      try {
        assertSafeName(jobId);
      } catch (err) {
        process.stderr.write(`[remote] ${(err as Error).message}\n`);
        process.exitCode = 1;
        return;
      }
      const job = listJobs().find((e) => e.id === jobId);
      if (!job) {
        process.stderr.write(
          `[remote] no job "${jobId}" (see: remote jobs ls)\n`,
        );
        process.exitCode = 1;
        return;
      }
      const from = opts.from ?? parentInstance(job) ?? "remote:cli";
      const envelope = buildDecisionReply({ job, parentInstance: from, answer });
      try {
        const { path, written } = dropEnvelope(
          envelope,
          envelopeFileName("decision.reply", jobId, Date.now()),
        );
        process.stderr.write(
          `[remote] decision.reply for ${jobId} → ${envelope.to}` +
            `${written ? "" : " (already present, not overwritten)"}\n` +
            `[remote] envelope: ${path}\n` +
            `[remote] delivered to the job's Pod on the next: remote h2a bridge\n`,
        );
      } catch (error) {
        process.stderr.write(
          `[remote] failed to write decision.reply: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // P4 — the CONDUCTOR. A single pass: (a) reconcile job state (consume finished
  // jobs → frees a slot + emits job.done + realizes the track mirror), (b) start
  // `pending` jobs while `running < cap`, via the SAME `startJob` path delegate
  // uses. With `--watch <min>` it loops in the FOREGROUND (dedicated tmux
  // window, like `h2a bridge --watch`), no daemon. SIGINT → clean exit 0.
  const conductPass = async (
    cap: number,
  ): Promise<{ started: number; finished: number }> => {
    const before = listJobs();
    const terminalBefore = before.filter(
      (j) => j.jobState === "done" || j.jobState === "failed",
    ).length;
    // (a) reconcile (also emits job.done + realizes track mirror on terminal).
    const after = await reconcileJobs();
    const terminalAfter = after.filter(
      (j) => j.jobState === "done" || j.jobState === "failed",
    ).length;
    const finished = Math.max(0, terminalAfter - terminalBefore);
    // (b) start pending jobs under the cap (oldest-first FIFO).
    let started = 0;
    for (const id of planNextStarts(after, cap)) {
      const job = listJobs().find((e) => e.id === id);
      if (!job) continue;
      const result = await startJob(job);
      if (result.started) {
        started += 1;
        process.stderr.write(
          `[remote] conduct: started ${id} (${job.tool}) ${result.target === "remote" ? "→ " : "in "}${result.detail}\n`,
        );
      } else {
        // A launch failure fails the job (frees nothing it didn't hold) so the
        // queue keeps moving; the error is recorded on stderr.
        advanceJob(id, "failed");
        process.stderr.write(
          `[remote] conduct: failed to start ${id}: ${result.error}\n`,
        );
      }
    }
    return { started, finished };
  };

  jobsCommand
    .command("conduct")
    .description(
      "Conductor: reconcile job state, consume finished jobs, and START queued (pending) jobs while running < cap — the SAME launch path as `remote delegate`. One pass by default; `--watch <min>` loops in the FOREGROUND (run in a dedicated tmux window, no daemon; Ctrl-C to stop).",
    )
    .option(
      "--watch <minutes>",
      "loop in the foreground every <minutes> (whole number >= 1); without it, runs a single pass and exits",
    )
    .option(
      "--max-concurrent <n>",
      "concurrency cap (default: config maxConcurrent / REMOTE_MAX_CONCURRENT / 16)",
    )
    .option(
      "--max-depth <d>",
      "spawn-depth budget recorded for jobs this conductor starts (clamp 1–3, default: each job's recorded budget)",
    )
    .action(
      async (opts: {
        watch?: string;
        maxConcurrent?: string;
        maxDepth?: string;
      }) => {
        const capRaw =
          opts.maxConcurrent !== undefined
            ? Number.parseInt(opts.maxConcurrent, 10)
            : getMaxConcurrent() ?? DEFAULT_MAX_CONCURRENT;
        const cap =
          Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_MAX_CONCURRENT;
        // `--max-depth` here clamps the budget the conductor re-stamps on the
        // jobs it starts (a job enrolled by a parent already carries its budget;
        // this only matters for jobs the conductor may re-stamp). Validate it.
        if (opts.maxDepth !== undefined) {
          clampDepth(Number.parseInt(opts.maxDepth, 10));
        }
        const minutes =
          opts.watch === undefined ? undefined : parseWatchMinutes(opts.watch);
        if (minutes === undefined) {
          const { started, finished } = await conductPass(cap);
          process.stderr.write(
            `[remote] conduct: cap ${cap} — ${started} started, ${finished} finished\n`,
          );
          return;
        }
        process.stderr.write(
          `[remote] conducting (cap ${cap}, every ${minutes} min) — Ctrl-C to stop\n`,
        );
        process.exitCode = await conductLoop(minutes, () => conductPass(cap));
      },
    );

  // ---------------------------------------------------------------------------
  // WP10 — conductor-launch: handle h2a `conductor-launch-request` envelopes.
  //
  // h2a (a2a-cli, h2a 0.68.0) EMITS an envelope into remote's h2a inbox when a
  // workspace has stalled work AND no live conductor; h2a NEVER spawns — remote
  // executes. We read the freshest unprocessed envelope, decide (idempotency vs
  // our own job registry + a best-effort `h2a discover`, per-workspace cooldown,
  // host availability on PATH), and LAUNCH a conductor via the SAME delegation
  // path (`startJob`) — gated by `--confirm` (else dry-run). The launched
  // conductor's task tells it to claim the conductor role at boot.
  //
  // Reversible defaults (documented here + in conductor-launch.ts):
  //  - jobId = `conductor-<first 12 hex of the durable workspace hash>` — stable,
  //    so a relaunch attempt for the SAME workspace reuses the slug and the live
  //    job is found (registry-level idempotency on top of the launch gate).
  //  - host detection = login-shell `command -v` for claude/codex/agy (same probe
  //    as the tmux side-window), default order = the envelope's hostPref.
  //  - durable-id input = git remote origin url if present, else the repo
  //    toplevel (canonicalized). MISMATCH with the envelope's workspaceId is
  //    logged and acts as a guard (flagged for a2a-cli alignment).
  //  - cooldown default = 30 min / workspace; processed-marking = sibling
  //    `.processed` stamp (non-destructive, like dropEnvelope).
  // ---------------------------------------------------------------------------

  /** Durable id of the CURRENT repo: git remote origin url, else toplevel path. */
  const localDurableWorkspaceId = (): string | undefined => {
    try {
      const git = (args: string[]) =>
        spawnSync("git", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      // rootCommitSHA = ALL root commits, sorted asc, joined "," (a2a-cli/track algo).
      const roots = git(["rev-list", "--max-parents=0", "HEAD"]);
      if (roots.status !== 0) return undefined;
      const rootCommitSHA = normalizeRootCommits(roots.stdout.split("\n"));
      if (!rootCommitSHA) return undefined;
      // worktreeRelPath = "" for the primary worktree, else basename(git-dir)
      // for a linked one (git-dir !== git-common-dir).
      const dir = git(["rev-parse", "--git-dir"]);
      const common = git(["rev-parse", "--git-common-dir"]);
      const dirPath = dir.status === 0 ? dir.stdout.trim() : "";
      const commonPath = common.status === 0 ? common.stdout.trim() : "";
      const worktreeRelPath =
        dirPath && commonPath && dirPath !== commonPath
          ? basename(dirPath)
          : "";
      return computeDurableWorkspaceId(rootCommitSHA, worktreeRelPath);
    } catch {
      return undefined;
    }
  };

  /**
   * Count conductors we already know to be ALIVE for `workspaceId`:
   *  - our own registry: live `role:"job"` jobs in `running` state whose id is
   *    the deterministic conductor slug for this workspace, PLUS
   *  - h2a's own view (`h2a discover`), best-effort: +1 if it reports one, 0 if
   *    it ran and didn't, ignored entirely when h2a is unavailable.
   */
  const countLiveConductors = (workspaceId: string, slug: string): number => {
    let n = 0;
    for (const job of listJobs()) {
      if (job.role !== "job") continue;
      if ((job.jobState ?? "pending") !== "running") continue;
      if (job.id === slug && isLive(job)) n += 1;
    }
    const h2aSays = h2aReportsLiveConductor(workspaceId);
    if (h2aSays === true) n += 1;
    return n;
  };

  /**
   * Process ONE conductor-launch request. Returns a short outcome for the watch
   * loop's recap. `confirm=false` → DRY-RUN (decide + print, launch nothing, do
   * NOT mark processed so a later `--confirm` run can still act). With confirm,
   * a launched/skipped envelope is marked processed (idempotent stamp).
   */
  const processLaunchRequest = async (
    env: { path: string; request: ConductorLaunchRequest },
    confirm: boolean,
    cooldownMs: number,
  ): Promise<{ launched: boolean; detail: string }> => {
    const { request } = env;
    const slug = `conductor-${request.workspaceId.replace(/^ws:/, "").slice(0, 12)}`;

    // Durable-id alignment guard (flagged for a2a-cli): warn on a mismatch but
    // proceed — the envelope's workspaceId is authoritative for the launch.
    const localId = localDurableWorkspaceId();
    if (localId && localId !== request.workspaceId) {
      process.stderr.write(
        `[remote] conductor-launch: workspace id mismatch — envelope ${request.workspaceId} vs local ${localId} ` +
          `(proceeding with the envelope's id; align canonicalization with a2a-cli)\n`,
      );
    }

    const liveConductors = countLiveConductors(request.workspaceId, slug);
    const lastLaunchAt = readLastLaunchAt(request.workspaceId);
    const gate = shouldLaunch({
      request,
      liveConductors,
      lastLaunchAt,
      now: Date.now(),
      cooldownMs,
    });
    if (!gate.launch) {
      if (confirm) markLaunchEnvelopeProcessed(env.path, `skip: ${gate.reason}`);
      process.stderr.write(`[remote] conductor-launch: SKIP — ${gate.reason}\n`);
      return { launched: false, detail: gate.reason };
    }

    const available = detectAvailableHosts();
    const host = selectHost(request.hostPref, available);
    if (!host) {
      const detail = `no preferred host available on PATH (wanted ${request.hostPref.join("/")}, found ${[...available].join("/") || "none"})`;
      if (confirm) markLaunchEnvelopeProcessed(env.path, `skip: ${detail}`);
      process.stderr.write(`[remote] conductor-launch: SKIP — ${detail}\n`);
      return { launched: false, detail };
    }

    const task = buildConductorTask(request);
    if (!confirm) {
      process.stderr.write(
        `[remote] conductor-launch DRY-RUN — would launch a ${host} conductor "${slug}" ` +
          `for ${request.workspaceId} (${request.stalled.length} stalled item(s)). ` +
          `Re-run with --confirm to launch.\n`,
      );
      return { launched: false, detail: `dry-run (${host})` };
    }

    // Enroll + launch via the SAME path delegate uses (task rides argv, never a
    // shell string). Mark processed + record the cooldown timestamp regardless of
    // the spawn result (a failed spawn shouldn't tight-loop a watch).
    const launchEntry: RegistryEntry = {
      id: slug,
      tool: host,
      kind: "local-tmux",
      cwd: process.cwd(),
      enrolledAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      source: "run",
      label: slug,
      role: "job",
      jobState: "running",
      task,
      headless: false,
      originCwd: process.cwd(),
      depthBudget: clampDepth(undefined),
    };
    enroll({
      id: slug,
      tool: host,
      kind: "local-tmux",
      cwd: process.cwd(),
      source: "run",
      label: slug,
      role: "job",
      jobState: "pending",
      task,
      headless: false,
      originCwd: process.cwd(),
      depthBudget: clampDepth(undefined),
    });
    const result = await startJob(launchEntry);
    recordLaunchAt(request.workspaceId);
    markLaunchEnvelopeProcessed(
      env.path,
      result.started ? `launched ${host} ${slug}` : `launch-failed: ${result.error}`,
    );
    if (!result.started) {
      advanceJob(slug, "failed");
      process.stderr.write(
        `[remote] conductor-launch: FAILED to launch ${slug}: ${result.error}\n`,
      );
      return { launched: false, detail: result.error };
    }
    process.stderr.write(
      `[remote] conductor-launch: launched ${host} conductor ${slug} for ${request.workspaceId} in ${result.detail}\n` +
        `[remote] supervise: remote jobs status ${slug}   attach: remote jobs attach ${slug}\n`,
    );
    return { launched: true, detail: `${host} ${slug}` };
  };

  /** One pass: handle the freshest unprocessed launch envelope (or report none). */
  const launchPass = async (
    confirm: boolean,
    cooldownMs: number,
  ): Promise<{ started: number; finished: number }> => {
    const fresh = freshestLaunchEnvelope(readLaunchEnvelopes());
    if (!fresh) {
      process.stderr.write(
        "[remote] conductor-launch: no unprocessed conductor-launch-request in the h2a inbox\n",
      );
      return { started: 0, finished: 0 };
    }
    const r = await processLaunchRequest(fresh, confirm, cooldownMs);
    return { started: r.launched ? 1 : 0, finished: 0 };
  };

  program
    .command("conductor-launch")
    .description(
      "Handle an h2a `conductor-launch-request` envelope: when h2a reports stalled work and no live conductor, launch one (claude/codex/agy, first available on PATH) via the same delegation path as `remote delegate`, instructed to claim the conductor role at boot. DRY-RUN unless --confirm. Idempotent (skips when a conductor is already alive) and rate-limited per workspace (cooldown). One pass by default; --watch loops in the FOREGROUND (no daemon; Ctrl-C to stop).",
    )
    .option(
      "--confirm",
      "actually launch (default: dry-run — decide and print what WOULD launch, launch nothing)",
    )
    .option(
      "--watch <minutes>",
      "loop in the foreground every <minutes> (whole number >= 1); without it, runs a single pass and exits",
    )
    .option(
      "--cooldown <min>",
      "minimum minutes between launches for the SAME workspace (default 30)",
    )
    .action(
      async (opts: { confirm?: boolean; watch?: string; cooldown?: string }) => {
        const confirm = opts.confirm === true;
        const cooldownMin =
          opts.cooldown !== undefined ? Number(opts.cooldown) : 30;
        if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
          throw new Error("--cooldown must be a non-negative number of minutes");
        }
        const cooldownMs = cooldownMin * 60_000;
        const minutes =
          opts.watch === undefined ? undefined : parseWatchMinutes(opts.watch);
        if (!confirm) {
          process.stderr.write(
            "[remote] conductor-launch: DRY-RUN (no --confirm) — nothing will be launched\n",
          );
        }
        if (minutes === undefined) {
          await launchPass(confirm, cooldownMs);
          return;
        }
        process.stderr.write(
          `[remote] conductor-launch watching (every ${minutes} min, cooldown ${cooldownMin} min${confirm ? "" : ", DRY-RUN"}) — Ctrl-C to stop\n`,
        );
        process.exitCode = await conductLoop(minutes, () =>
          launchPass(confirm, cooldownMs),
        );
      },
    );

  // ---------------------------------------------------------------------------
  // relaunch — bring idle local sessions back in situ, each resuming its OWN conv
  // ---------------------------------------------------------------------------

  program
    .command("relaunch [filter]")
    .description(
      "Relaunch the CLI in local tmux sessions whose CLI dropped to a shell, in situ (windows kept), each resuming ITS OWN conversation from the registry. Running sessions are left alone. Dry-run by default; --apply to do it. [filter] = only sessions whose slug contains it.",
    )
    .option("--apply", "actually relaunch (default: dry-run, just print the plan)")
    .action((filter: string | undefined, opts: { apply?: boolean }) => {
      if (!tmuxAvailable()) {
        process.stderr.write("[remote] tmux is not installed locally\n");
        process.exitCode = 1;
        return;
      }
      // slug -> its own convId (local-tmux registry entries; slug is the id).
      const convBySlug = new Map<string, string>();
      for (const e of loadRegistry()) {
        if (e.kind === "local-tmux" && e.convId) convBySlug.set(e.id, e.convId);
      }
      const sessions = listLocalSessions().filter(
        (s) => !filter || s.slug.includes(filter),
      );
      const plan = planRelaunch(
        sessions.map((s) => ({
          slug: s.slug,
          name: s.name,
          profile: s.profile,
          idle: localSessionIdle(s.name),
          ...(convBySlug.has(s.slug)
            ? { convId: convBySlug.get(s.slug)! }
            : {}),
        })),
      );
      if (plan.actions.length === 0) {
        process.stderr.write(
          `[remote] nothing to relaunch${filter ? ` matching "${filter}"` : ""} (${plan.skipped.length} skipped)\n`,
        );
        for (const s of plan.skipped) {
          process.stderr.write(`  - ${s.slug}: ${s.reason}\n`);
        }
        return;
      }
      if (!opts.apply) {
        process.stderr.write(
          `[remote] would relaunch ${plan.actions.length} session(s) — dry-run, pass --apply:\n`,
        );
        for (const a of plan.actions) {
          process.stderr.write(`  ${a.slug}: ${a.cmd}\n`);
        }
        for (const s of plan.skipped) {
          process.stderr.write(`  (skip) ${s.slug}: ${s.reason}\n`);
        }
        return;
      }
      let ok = 0;
      for (const a of plan.actions) {
        if (relaunchInSession(a.name, a.cmd)) {
          ok += 1;
          process.stderr.write(`[remote] relaunched ${a.slug}: ${a.cmd}\n`);
        } else {
          process.stderr.write(`[remote] FAILED to relaunch ${a.slug}\n`);
        }
      }
      process.stderr.write(
        `[remote] relaunched ${ok}/${plan.actions.length}${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ""}\n`,
      );
    });

  // ---------------------------------------------------------------------------
  // h2a — bridge the local agent network (~/h2a-workspace/.h2a) with session Pods
  // ---------------------------------------------------------------------------

  const h2aCommand = program
    .command("h2a")
    .description(
      "h2a agent-network helpers (local file store: ~/h2a-workspace/.h2a)",
    );
  h2aCommand
    .command("bridge [sessionId]")
    .description(
      "Bridge h2a envelopes with session Pod(s) over kubectl exec: PULL envelopes the Pod's agent emitted (Pod inbox/* minus the Pod's own instances) into the local inboxes, PUSH local envelopes addressed to the Pod's instances (<tool>:remote:<sessionId> + the Pod's registry) into the Pod. Idempotent by file name (existing files are skipped, never overwritten), NEVER deletes (acks/cleanup belong to h2a). A Pod without ~/h2a-workspace/.h2a gets the skeleton + README. Without sessionId: every live session.",
    )
    .option(
      "--watch <minutes>",
      "repeat the bridge every N minutes in the FOREGROUND; Ctrl-C to stop",
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ remote h2a bridge sess-abc         one pass for one session",
        "  $ remote h2a bridge                  one pass for every live session",
        "  $ remote h2a bridge --watch 5        foreground loop, every 5 min",
        "  Run the watch in a dedicated tmux window, e.g.:",
        "    tmux new-window -n h2a-bridge 'remote h2a bridge --watch 5'",
        "",
      ].join("\n"),
    )
    .action(async (sessionId: string | undefined, opts: { watch?: string }) => {
      const watchMinutes =
        opts.watch === undefined ? undefined : parseWatchMinutes(opts.watch);
      // Dynamic import: keeps the h2a bridge out of every other command's path.
      const { bridgeSession } = await import("./h2a-bridge.js");
      const url = getConfiguredRemote();
      await ensureConnected(url);
      const pass = async (): Promise<{ failed: number }> => {
        // Re-ensure the tunnel each pass (idempotent): a --watch loop must
        // survive a control-plane redeploy that kills the port-forward.
        await ensureConnected(url);
        const sessions = sessionId
          ? [
              {
                id: sessionId,
                profile: (await getRemoteSession(url, sessionId)).session
                  .profile,
              },
            ]
          : (await listRemoteSessions(url)).map((s) => ({
              id: s.id,
              profile: s.profile,
            }));
        if (sessions.length === 0) {
          process.stderr.write("[remote] no live remote sessions to bridge\n");
          return { failed: 0 };
        }
        let failed = 0;
        for (const s of sessions) {
          try {
            const r = await bridgeSession(s.id, { profile: s.profile });
            if (r.failed > 0) failed += 1;
            process.stderr.write(
              `[remote] h2a bridge ${s.id} (${s.profile}) pulled=${r.pulled} pushed=${r.pushed} skipped=${r.skipped}` +
                `${r.failed > 0 ? ` failed=${r.failed}` : ""}` +
                `${r.scaffolded ? " (pod .h2a scaffolded)" : ""}\n`,
            );
          } catch (error) {
            failed += 1;
            process.stderr.write(
              `[remote] h2a bridge ${s.id} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
            );
          }
        }
        return { failed };
      };
      if (watchMinutes !== undefined) {
        process.exitCode = await watchRefreshLoop(watchMinutes, pass);
        return;
      }
      const { failed } = await pass();
      if (failed > 0) process.exitCode = 1;
    });

  program
    .command("restore [group]")
    .description(
      "Relance les sessions dev dans leur layout (fenêtre par groupe, onglet par session). Sans argument: tous les groupes. Avec [group]: ce lot seulement (ex: `remote restore \"full remote\"`). Groupes LOCAUX = claude/codex sous ~/src/* (tmux via `remote run`); groupes REMOTE = sessions SCW (`remote attach <id> --exec`). Layout: champ `layout` de la config.",
    )
    .option("--dry-run", "affiche le layout calculé sans ouvrir de terminaux")
    .action(async (group: string | undefined, opts: { dryRun?: boolean }) => {
      if (!tmuxAvailable()) {
        process.stderr.write(
          "[remote] tmux requis pour restore (sudo apt install tmux)\n",
        );
        process.exitCode = 1;
        return;
      }
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const cfg = getLayoutConfig();
      const needRemote = cfg.groups.some(
        (g) => g.remote && (!group || norm(g.title) === norm(group)),
      );

      const restoreOpts: RestoreOptions = {};
      if (group) restoreOpts.group = group;
      if (opts.dryRun) restoreOpts.dryRun = true;

      if (needRemote) {
        const url = getConfiguredRemote();
        await ensureConnected(url);
        const sessions = await listRemoteSessions(url);
        restoreOpts.remoteTabs = sessions.map((s) => {
          const wp = s.workspacePath;
          const cwd = wp && existsSync(wp) ? wp : homedir();
          return { id: s.id, label: projectName(s), cwd };
        });
        if (restoreOpts.remoteTabs.length === 0) {
          process.stderr.write(
            "[remote] aucune session SCW (remote ls vide) pour le groupe remote\n",
          );
        }
      }

      const { total } = restoreLayout(restoreOpts);
      if (total === 0) {
        process.stderr.write(
          `[remote] rien à relancer${group ? ` pour le groupe "${group}"` : ""}\n`,
        );
      } else {
        process.stderr.write(
          `[remote] ${total} onglet(s)${opts.dryRun ? " (dry-run, rien ouvert)" : " relancé(s)"}\n`,
        );
      }
    });

  // ---------------------------------------------------------------------------
  // enroll — live-session registry plumbing (called by Claude Code hooks)
  // ---------------------------------------------------------------------------

  program
    .command("enroll")
    .description(
      "Plumbing for the live-session registry (feeds `remote ls`/`remote restore`). " +
        "Hook mode (--hook claude-start|claude-end) is wired by --install-hooks into " +
        "~/.claude/settings.json (idempotent; backs up settings.json.bak.<epoch>) and " +
        "always exits 0 so it can never break the host claude session. " +
        "codex has no reliable session hook: codex sessions are enrolled by `remote run` " +
        "and by the restore filesystem-scan fallback. Manual mode: --tool/--cwd/--conv/--pid/--label.",
    )
    .option(
      "--hook <name>",
      "hook mode: claude-start | claude-end (reads the Claude Code hook JSON on stdin)",
    )
    .option(
      "--install-hooks",
      "merge the SessionStart/SessionEnd enroll hooks into Claude Code's settings.json (idempotent)",
    )
    .option(
      "--settings <path>",
      "settings.json path for --install-hooks (default: ~/.claude/settings.json)",
    )
    .option("--tool <tool>", "manual mode: claude | codex | agy")
    .option("--cwd <dir>", "manual mode: session working directory (default: cwd)")
    .option("--conv <id>", "manual mode: conversation id (used by restore --resume)")
    .option("--pid <pid>", "manual mode: process id used for liveness checks")
    .option("--label <label>", "manual mode: display label")
    .action(
      async (opts: {
        hook?: string;
        installHooks?: boolean;
        settings?: string;
        tool?: string;
        cwd?: string;
        conv?: string;
        pid?: string;
        label?: string;
      }) => {
        if (opts.installHooks) {
          const result = installClaudeHooks(opts.settings);
          if (!result.changed) {
            process.stderr.write(
              `[remote] enroll hooks already installed in ${result.settingsPath}\n`,
            );
            return;
          }
          if (result.backupPath) {
            process.stderr.write(`[remote] backup: ${result.backupPath}\n`);
          }
          process.stderr.write(
            `[remote] installed ${result.installed.join(" + ")} enroll hooks in ${result.settingsPath}\n`,
          );
          return;
        }
        if (opts.hook) {
          // MUST always exit 0: errors on stderr only, never break the hook host.
          try {
            const raw = await readStdin();
            const result = handleClaudeHook(opts.hook, raw);
            if (!result.ok) {
              process.stderr.write(
                `[remote] enroll hook ignored: ${result.error}\n`,
              );
            }
          } catch (error) {
            process.stderr.write(`[remote] enroll hook ignored: ${String(error)}\n`);
          }
          return;
        }
        if (opts.tool) {
          const result = manualEnroll({
            tool: opts.tool,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts.conv !== undefined ? { conv: opts.conv } : {}),
            ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
            ...(opts.label !== undefined ? { label: opts.label } : {}),
          });
          if (!result.ok) throw new Error(result.error ?? "enroll failed");
          process.stderr.write(`[remote] enrolled (${opts.tool})\n`);
          return;
        }
        process.stderr.write(
          "[remote] enroll: pass --hook <name>, --install-hooks, or --tool <tool> (see --help)\n",
        );
      },
    );

  const layoutCommand = program
    .command("layout")
    .description("Layout auto-enregistré par `remote restore` (layout-last.json)");

  layoutCommand
    .command("show")
    .description("Affiche le dernier layout lancé (fenêtres, onglets, commandes)")
    .action(() => {
      const last = readLastLayout();
      if (!last) {
        process.stderr.write(
          "[remote] aucun layout enregistré (lance `remote restore` d'abord)\n",
        );
        return;
      }
      process.stdout.write(`at: ${last.at}\n`);
      if (last.group) process.stdout.write(`group: ${last.group}\n`);
      for (const win of last.windows) {
        process.stdout.write(`\n${win.title} (${win.tabs.length} onglet(s))\n`);
        for (const t of win.tabs) {
          process.stdout.write(`  - ${t.label}  ${t.cwd}\n      ${t.cmd}\n`);
        }
      }
    });

  program
    .command("attach <urlOrSessionId> [sessionId]")
    .description(
      "Attach to a session. Resolves a LOCAL tmux session (by slug) first, otherwise a remote session on the control-plane. URL is optional when a default remote is configured.",
    )
    .option(
      "--exec",
      "force exec-into-Pod-tmux attach (this is the DEFAULT when a tunnel is configured: UTF-8, native scrollback + copy)",
    )
    .option(
      "--ws",
      "force the legacy WS/SSE attach (control-plane proxy) instead of exec",
    )
    .option("--local", "force local tmux lookup")
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: { exec?: boolean; ws?: boolean; local?: boolean },
      ) => {
        // Local tmux session? (unless an explicit URL/sessionId pair is given).
        if (second === undefined && !looksLikeUrl(first)) {
          const local = findLocalSession(first);
          if (opts.local || local) {
            if (!local) {
              process.stderr.write(
                `[remote] no local session "${first}" (see: remote ls)\n`,
              );
              process.exitCode = 1;
              return;
            }
            attachLocalSession(local.name);
            return;
          }
        }
        const { url, sessionId } = resolveUrlAndSessionId(first, second);
        const tunnel = getTunnel();
        // Default to exec-into-Pod-tmux (UTF-8, native scrollback + copy, direct,
        // no deaf-zombie) when a tunnel is configured; the WS/SSE proxy is the
        // fallback. Force either path with --exec / --ws.
        if (!opts.ws && (opts.exec || tunnel)) {
          if (!tunnel) {
            process.stderr.write(
              "[remote] --exec needs a tunnel configured (remote config tunnel …)\n",
            );
            process.exitCode = 1;
            return;
          }
          await ensureConnected(url);
          process.stderr.write(
            `[remote] exec-attaching into Pod tmux for ${sessionId} (Ctrl-b d to detach)\n`,
          );
          process.exitCode = attachPodTmux(tunnel, sessionId);
          return;
        }
        await ensureConnected(url);
        process.stderr.write(
          `[remote] attaching to ${url}/sessions/${sessionId} (WS)\n`,
        );
        const session = await attach({ baseUrl: url, sessionId });
        await session.finished;
      },
    );

  program
    .command("refresh [urlOrSessionId] [sessionId]")
    .description(
      "Re-bundle the local CLI credentials and push them to an existing remote session's Secret. The session's Pod is restarted by the control-plane so the new tokens take effect. Profile is auto-detected from the session.",
    )
    .option(
      "--profile <profile>",
      "override the auto-detected profile (rarely needed)",
    )
    .option("--no-auth", "skip bundling local credentials")
    .option(
      "--no-auth-refresh",
      "skip local auth status preflight before bundling credentials",
    )
    .option(
      "--soft",
      "push fresh creds INTO the running Pod + relaunch the CLI in place (no Pod recreate; keeps HOME + conversation; fixes the ~8h token logout)",
    )
    .option(
      "--all",
      "soft-refresh EVERY live remote session (implies --soft; profile per session); recap at the end, exit 1 if any failed",
    )
    .option(
      "--watch <minutes>",
      "repeat the (soft) refresh every N minutes in the FOREGROUND (implies --soft); Ctrl-C to stop. Respawns the Pod CLI only when creds actually changed",
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ remote refresh sess-abc --soft     refresh one session's creds in place",
        "  $ remote refresh --soft --all        refresh every live session once",
        "  $ remote refresh --all --watch 30    foreground loop: every 30 min, all sessions;",
        "                                       unchanged creds = no-op (no CLI respawn)",
        "  Run the watch in a dedicated tmux window, e.g.:",
        "    tmux new-window -n creds 'remote refresh --all --watch 30'",
        "",
      ].join("\n"),
    )
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        opts: RefreshOpts & { soft?: boolean; all?: boolean; watch?: string },
      ) => {
        const watchMinutes =
          opts.watch === undefined ? undefined : parseWatchMinutes(opts.watch);

        if (opts.all) {
          // --all implies --soft: it iterates live sessions in place.
          if (
            (first !== undefined && !looksLikeUrl(first)) ||
            second !== undefined
          ) {
            throw new Error(
              "--all refreshes every live session — don't pass a session id (only an optional URL).",
            );
          }
          const url = getConfiguredRemote(first);
          await ensureConnected(url);
          const hashes = new Map<string, string>();
          if (watchMinutes !== undefined) {
            // Re-ensure the tunnel EACH pass: after a control-plane redeploy
            // (or laptop sleep) the port-forward dies and every pass would
            // otherwise fail with "fetch failed". ensureConnected is idempotent
            // and rebuilds a stale-but-alive tunnel.
            process.exitCode = await watchRefreshLoop(watchMinutes, async () => {
              await ensureConnected(url);
              return softRefreshAllSessions(url, opts, hashes);
            });
            return;
          }
          const { failed } = await softRefreshAllSessions(url, opts, hashes);
          if (failed > 0) process.exitCode = 1;
          return;
        }

        if (first === undefined) {
          throw new Error(
            "Missing session id. Usage: remote refresh [url] <sessionId> [--soft] (or --soft --all).",
          );
        }
        const { url, sessionId } = resolveUrlAndSessionId(first, second);

        if (watchMinutes !== undefined) {
          // --watch implies --soft (gated: unchanged creds never respawn).
          await ensureConnected(url);
          const hashes = new Map<string, string>();
          process.exitCode = await watchRefreshLoop(watchMinutes, () =>
            softRefreshOneGated(url, sessionId, opts, hashes),
          );
          return;
        }

        if (opts.soft) {
          await ensureConnected(url);
          const profile =
            opts.profile ?? (await getRemoteSession(url, sessionId)).session.profile;
          const resolved = coerceCliProfileName(profile);
          if (!resolved) throw new Error(`Unknown profile "${profile}"`);
          if (opts.authRefresh !== false) {
            const fresh = await ensureProfileAuthFresh(resolved);
            if (fresh.checked)
              process.stderr.write(`[remote] auth status ok: ${fresh.command}\n`);
          }
          await softRefreshSession(sessionId, resolved);
          return;
        }
        await refreshProfileSession(url, sessionId, opts);
      },
    );

  program
    .command("ls [url]")
    .description("List sessions — LOCAL (tmux) and REMOTE (control-plane) — uniformly")
    .option("--local", "list only local tmux sessions (no control-plane call)")
    .action(async (url: string | undefined, opts: { local?: boolean }) => {
      const w = (s: string, n: number) => s.padEnd(n);
      // Registry + tmux: enrolled sessions show [registry] (reliable cwd/conv),
      // tmux-only ones show [guess]; dead registry entries are pruned.
      const local = listLocalForLs();

      if (local.length > 0) {
        process.stdout.write("LOCAL (tmux + registry)\n");
        process.stdout.write(
          `  ${w("PROJECT", 20)} ${w("PROFILE", 7)} ${w("STATE", 9)} ${w("SOURCE", 10)} PATH\n`,
        );
        for (const s of local) {
          process.stdout.write(
            `  ${w(s.slug, 20)} ${w(s.profile, 7)} ${w(s.state, 9)} ${w(`[${s.badge}]`, 10)} ${s.path}\n`,
          );
        }
      }

      if (opts.local) {
        if (local.length === 0) process.stderr.write("[remote] no local sessions\n");
        return;
      }

      const remote = url ?? getConfiguredRemoteOptional();
      if (!remote) {
        if (local.length === 0) {
          process.stderr.write(
            "[remote] no local sessions and no remote configured\n",
          );
        }
        return;
      }
      await ensureConnected(remote);
      const sessions = await listRemoteSessions(remote);
      if (sessions.length === 0) {
        if (local.length === 0) process.stderr.write("[remote] no sessions\n");
        return;
      }
      if (local.length > 0) process.stdout.write("\n");
      process.stdout.write("REMOTE (control-plane)\n");
      process.stdout.write(
        `  ${w("PROJECT", 20)} ${w("WORKSPACE", 13)} ${w("PROFILE", 7)} ${w("SESSION", 15)} TARGET\n`,
      );
      for (const s of sessions) {
        process.stdout.write(
          `  ${w(projectName(s), 20)} ${w(s.workspaceId ?? "-", 13)} ${w(s.profile, 7)} ${w(s.id, 15)} ${s.target}\n`,
        );
      }
    });

  program
    .command("stop <urlOrSessionId> [sessionId]")
    .description(
      "Stop a session. Resolves a LOCAL tmux session (by slug) first (kills it), otherwise stops a remote session on the control-plane.",
    )
    .option("--reason <reason>", "reason recorded with the stop")
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: { reason?: string },
      ) => {
        // Local tmux session? (unless an explicit URL/sessionId pair is given).
        if (second === undefined && !looksLikeUrl(first)) {
          const local = findLocalSession(first);
          if (local) {
            const ok = killLocalSession(local.name);
            process.stderr.write(
              `[remote] local session ${local.slug} ${ok ? "killed" : "could not be killed"}\n`,
            );
            if (!ok) process.exitCode = 1;
            return;
          }
        }
        const { url, sessionId } = resolveUrlAndSessionId(first, second);
        const result = await stopRemoteSession(url, sessionId, opts.reason);
        process.stderr.write(
          `[remote] stop ${result.accepted ? "accepted" : "rejected"} for ${sessionId}\n`,
        );
      },
    );

  await program.parseAsync([...argv]);
  const code = process.exitCode;
  return typeof code === "number" ? code : 0;
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv).catch((error: unknown) => {
    if (
      error instanceof AuthRefreshError ||
      error instanceof AuthBundleMissingError
    ) {
      console.error(error.message);
    } else {
      console.error("[remote] fatal:", error);
    }
    process.exitCode = 1;
  });
}
