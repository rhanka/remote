#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  renameRemoteSession,
  sessionTerminalHealth,
  stopRemoteSession,
} from "./attach.js";
import {
  authHeaders,
  clearDefaultRemote,
  getDefaultRemote,
  getDefaultTarget,
  getDefaultTools,
  getH2aConfig,
  getJobMaxAgeHours,
  getMaxConcurrent,
  getTunnel,
  resolveConfigPath,
  setDefaultRemote,
  setDefaultTarget,
  setDefaultTools,
  setToken,
  setTunnel,
  type TunnelConfig,
} from "./config.js";
import { ensureConnected, stopTunnel } from "./tunnel.js";
import { detectToolAuth, KNOWN_TOOLS, partitionTools } from "./auth-tools.js";
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
  resolveAgentPaneForInstance,
  sessionAttachedCount,
  setLocalSessionDisplayName,
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
  coerceRegistryTool,
  enroll,
  enrollFromRun,
  isLive,
  listJobs,
  listLocalForLs,
  loadRegistry,
  tryClaimSlot,
  withRegistryLock,
  resolveRegistryPath,
  type RegistryEntry,
  type ThrottleInfo,
} from "./registry.js";
import {
  aimdEffectiveCap,
  assertSafeName,
  buildDelegateArgs,
  buildJobRows,
  buildRemoteDelegate,
  buildThrottleResumeArgs,
  canDelegateAtDepth,
  childDepthEnvValue,
  clampDepth,
  clampRemoteDepthBudget,
  conductorAdvisory,
  DEFAULT_MAX_CONCURRENT,
  DEPTH_ENV,
  inheritedDepthBudget,
  isDelegateType,
  isThrottleResumeDue,
  jitteredBackoffMs,
  JOB_ID_ENV,
  jobDir,
  planNextStarts,
  planThrottleStep,
  readJobResult,
  THROTTLE_MAX_ATTEMPTS,
  reconcileRemoteJobs,
  renderJobsTable,
  resolveJobCwd,
  runTrackMirror,
  sweepStaleJobs,
  trackItemNewArgs,
  trackItemRealizeArgs,
  type DelegateType,
} from "./delegate.js";
import { detectThrottle, THROTTLE_TAIL_LINES } from "./throttle-signatures.js";
import {
  interactiveResumeNudge,
  planInteractiveResume,
  type InteractiveResumePlan,
  type InteractiveSession,
  type InteractiveThrottleInfo,
} from "./interactive-throttle.js";
import { promptProfileMenu, shouldShowProfileMenu } from "./profile-menu.js";
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
import { defaultLocalH2aRoot } from "./h2a-bridge.js";
import { guardConvWriters } from "./conv-guard.js";
import {
  handleClaudeHook,
  installClaudeHooks,
  manualEnroll,
  readStdin,
} from "./enroll.js";
import { probePodCredHealth, softRefreshSession } from "./soft-refresh.js";
import { checkPodLiveness, deadPodAdvisory } from "./pod-liveness.js";
import {
  claudeExpiryAdvisory,
  claudeTokenExpiry,
  supervisorAdvisory,
  SUPERVISOR_HEARTBEAT_FILE,
} from "./cred-health.js";
import { forwardSessionPort } from "./forward.js";
import { buildBrowserOpenPlan } from "./browser.js";
import { remoteSessionIdFromInstance, sendH2aPing } from "./h2a-ping.js";
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
import {
  coerceCliProfileName,
  isCliProfile,
  resolveProfile,
  resumeArgsFor,
} from "./profiles.js";
import { getLoginCommand, runInteractiveLogin } from "./auth-login.js";
import {
  buildWorkspaceArchive,
  uploadWorkspaceArchive,
} from "./workspace-sync.js";
import {
  emptyMetrics,
  readSyncStatus,
  type SyncStatus,
} from "./sync-status.js";
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
import { restoreSessionsToLocal, type OnConflict } from "./session-restore.js";
import { run } from "./run.js";
import {
  pluginAdd,
  pluginAddInstaller,
  pluginLs,
  pluginSync,
  pluginSyncCheck,
  reconcileSessionPlugins,
} from "./plugin.js";
import { syncSkills } from "./skills-sync.js";
import { smokeRemoteProfile } from "./smoke.js";
import { migrateForward, migrateBack } from "./migrate.js";
import {
  listMigrationCandidates,
  humanSize,
  humanAge,
} from "./migrate-candidates.js";
import {
  acquireLease,
  createLineage,
  handoffLease,
  isIncarnationSuspended,
  listLineages,
  resumeLocalIncarnation,
  suspendLocalIncarnation,
  updateLineage,
  type LineageId,
} from "./lineage-lease.js";
import { checkReadiness } from "./readiness.js";
import { createInterface } from "node:readline";
import {
  appendSessionLogEntry,
  clearExhaustion,
  enrollAccount,
  listAccounts,
  listAccountsWithStatus,
  markExhausted,
  readClaudeCredential,
  readCodexCredential,
  removeAccount,
  selectAccount,
  selectAccountWithFallback,
  stickyBind,
  loadCandidates,
  sessionLogPath,
  QUOTA_WINDOW_5H_MS,
  QUOTA_WINDOW_WEEK_MS,
  type AccountProvider,
} from "./account-pool.js";

import { CLI_PROFILES, type CliProfile } from "@sentropic/remote-protocol";

const KNOWN_PROFILE_HELP = `${CLI_PROFILES.join(", ")} (aliases: claude-code, antigravity, gemini-cli, mistralcli)`;

export const packageName = "@sentropic/remote-cli";

export { run } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";
export {
  attach,
  createRemoteSession,
  getRemoteSession,
  listRemoteSessions,
  refreshRemoteSession,
  renameRemoteSession,
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
  pluginSyncCheck,
  reconcileSessionPlugins,
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
  /** WP7 — add the headful-browser noVNC sidecar to this session. */
  browser?: boolean;
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
  name?: string;
};

function describeAuthStatus(status: AuthDiagnosticsStatus): string {
  if (status.checked) return `ok: ${status.command}`;
  return `skipped: ${status.reason}`;
}

function resumeStartupArgs(
  profileName: string,
  resume: string | true,
): string[] {
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
      const ws = await createWorkspace(remote, {
        displayName: member.workspaceName,
      });
      const session = await createRemoteSession(remote, {
        profile: profileName,
        target,
        workspaceId: ws.id,
        displayName: member.name,
        ...(spec.startupArgs.length > 0
          ? { startupArgs: spec.startupArgs }
          : {}),
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
      return [
        member.name,
        r.value.sessionId,
        r.value.workspaceId,
        "created",
      ].join("\t");
    }
    return [
      member.name,
      "-",
      "-",
      `FAILED: ${(r.reason as Error).message}`,
    ].join("\t");
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
    if (opts.resume !== undefined && resumeArgs.length === 0) {
      throw new Error(
        `profile "${profileName}" has no verified resume argv; start it without -r/--resume`,
      );
    }
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
      const members = planRemoteFanout({
        base,
        count,
        max: DEFAULT_FANOUT_MAX,
      });
      await startRemoteFanout(opts.remote, profileName, members, {
        target: opts.target,
        startupArgs,
        ...(credentials ? { credentials } : {}),
      });
      return;
    }

    let archive: Buffer | undefined;
    if (opts.sync) {
      process.stderr.write(
        `[remote] packing ${process.cwd()} (respecting .gitignore)\n`,
      );
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
      ...(opts.browser ? { metadata: { browser: true } } : {}),
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
  if (
    opts.profile &&
    coerceCliProfileName(opts.profile) !== coerceCliProfileName(remoteProfile)
  ) {
    process.stderr.write(
      `[remote] warning: --profile ${opts.profile} does not match the session profile ${remoteProfile}; bundling ${opts.profile} credentials anyway\n`,
    );
  }
  const profileName = coerceCliProfileName(requestedProfile);
  if (!profileName) {
    throw new Error(
      `Unknown profile "${requestedProfile}". Known: ${KNOWN_PROFILE_HELP}`,
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

  const response = await refreshRemoteSession(
    baseUrl,
    sessionId,
    credentials,
    fetch,
    opts.name,
  );
  process.stderr.write(
    `[remote] refresh ${response.accepted ? "accepted" : "rejected"} for ${response.sessionId}` +
      (opts.name ? ` (renamed → ${opts.name})` : "") +
      "\n",
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

// ---------------------------------------------------------------------------
// Slice 2 — creds SUPERVISOR heartbeat + advisories (additive, zero-risk).
// ---------------------------------------------------------------------------

/** The creds-supervisor heartbeat file under the remote-cli config dir. */
function supervisorHeartbeatPath(): string {
  // Same config dir the rest of remote-cli uses (honors REMOTE_CLI_CONFIG_HOME
  // in tests). Reuses resolveConfigPath's directory.
  return join(resolveConfigPath(), "..", SUPERVISOR_HEARTBEAT_FILE);
}

/** Touch the heartbeat file (best-effort): the `refresh --watch` loop calls it each pass. */
function writeSupervisorHeartbeat(nowMs: number = Date.now()): void {
  try {
    const path = supervisorHeartbeatPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${new Date(nowMs).toISOString()}\n`, "utf8");
  } catch {
    // best-effort: a heartbeat write failure must NEVER break the refresh pass.
  }
}

/** The heartbeat file's mtime in ms, or undefined when absent/unreadable. */
function readSupervisorHeartbeatMtime(): number | undefined {
  try {
    return statSync(supervisorHeartbeatPath()).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The supervisor-staleness advisory for the LS surfaces. Reads the heartbeat
 * mtime and the configured watch interval (recorded alongside the heartbeat by
 * the watch loop) and asks the pure `supervisorAdvisory`. We only warn when an
 * interval is known (no interval ⇒ the user never started a watcher with a
 * recorded cadence; a MISSING heartbeat still warns). Returns undefined when
 * fresh / unknown-but-present.
 */
function supervisorStalenessAdvisory(
  now: number = Date.now(),
): string | undefined {
  const mtime = readSupervisorHeartbeatMtime();
  const intervalMs = readSupervisorIntervalMs();
  // No heartbeat at all → loud MISSING warning regardless of interval.
  if (mtime === undefined)
    return supervisorAdvisory(undefined, intervalMs ?? 0, now);
  if (intervalMs === undefined) return undefined; // present but cadence unknown
  return supervisorAdvisory(mtime, intervalMs, now);
}

/** Sidecar file recording the watch interval (ms) so `ls` can judge staleness. */
function supervisorIntervalPath(): string {
  return join(resolveConfigPath(), "..", "supervisor-interval-ms");
}

function writeSupervisorIntervalMs(intervalMs: number): void {
  try {
    const path = supervisorIntervalPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${intervalMs}\n`, "utf8");
  } catch {
    // best-effort
  }
}

function readSupervisorIntervalMs(): number | undefined {
  try {
    const n = Number(readFileSync(supervisorIntervalPath(), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detection-only advisory for the LOCAL claude OAuth token expiry. Reads the
 * local `.claude/.credentials.json` and, when the token is expired / within the
 * warn window, returns a loud "run claude locally" message. NO auto-action and
 * NO change to what gets pushed — detection + advisory only (slice 2). Returns
 * undefined when fresh / absent.
 */
function localClaudeExpiryAdvisory(
  now: number = Date.now(),
): string | undefined {
  try {
    const raw = readFileSync(
      join(homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
    return claudeExpiryAdvisory(claudeTokenExpiry(raw, now));
  } catch {
    return undefined; // no local claude creds → nothing to warn about
  }
}

type SoftRefreshAllOutcome = {
  sessionId: string;
  profile: string;
  status: "ok" | "unchanged" | "failed" | "skipped-dead";
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
  // Slice 2: prove the watcher is alive THIS pass (heartbeat) + warn (detection
  // only) when the local claude OAuth token is expiring — both before any work,
  // so even a zero-session pass refreshes the heartbeat and surfaces the warning.
  writeSupervisorHeartbeat();
  const claudeWarn = localClaudeExpiryAdvisory();
  if (claudeWarn) process.stderr.write(`${claudeWarn}\n`);

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
    // DEAD-POD GUARD: an Evicted/OOM/completed Pod (phase != Running) can't be
    // exec'd into — every push/probe/reconcile below would log a per-pass error.
    // Check the phase ONCE and SKIP with a single concise advisory. Running Pods
    // proceed exactly as before (one extra cheap `kubectl get pod` per pass).
    const tunnel = getTunnel();
    if (tunnel) {
      const liveness = checkPodLiveness(tunnel, `session-${s.id}`);
      if (!liveness.executable) {
        process.stderr.write(`${deadPodAdvisory(s.id, liveness.phase)}\n`);
        outcomes.push({
          sessionId: s.id,
          profile,
          status: "skipped-dead",
          detail: `pod ${liveness.phase || "gone"}`,
        });
        continue;
      }
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
      // Slice 2: ADDITIONAL trigger — probe the cheap-to-check tools (gh/npm/
      // docker) in this live Pod; a 401 pushes that tool's creds via the SAME
      // mechanism. Best-effort: never fails the profile refresh outcome.
      try {
        const actions = await probePodCredHealth(s.id);
        for (const a of actions) {
          if (!a.health.ok) {
            process.stderr.write(
              `[remote]   ${s.id}: ${a.health.reason}${a.pushed ? " — pushed" : ""}\n`,
            );
          }
        }
      } catch (probeError) {
        process.stderr.write(
          `[remote]   ${s.id}: tool health probe skipped: ${String(probeError).slice(0, 120)}\n`,
        );
      }
      // Slice 3: ADDITIONAL trigger — compare the local desired-state manifest
      // hash with the Pod's recorded sidecar; on drift, re-run the EXISTING
      // buildPodSyncScript (an extra trigger, not a new push). Best-effort.
      try {
        reconcileSessionPlugins(s.id, profile);
      } catch (driftError) {
        process.stderr.write(
          `[remote]   ${s.id}: plugin drift reconcile skipped: ${String(driftError).slice(0, 120)}\n`,
        );
      }
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
  // Slice 2: heartbeat + claude-expiry detection on every gated pass too.
  writeSupervisorHeartbeat();
  const claudeWarn = localClaudeExpiryAdvisory();
  if (claudeWarn) process.stderr.write(`${claudeWarn}\n`);
  try {
    const profileName =
      opts.profile ?? (await getRemoteSession(url, sessionId)).session.profile;
    const profile = coerceCliProfileName(profileName);
    if (!profile) throw new Error(`Unknown profile "${profileName}"`);
    // DEAD-POD GUARD: skip a non-Running (Evicted/OOM/completed) Pod with a
    // single advisory instead of hammering exec each pass. Running = unchanged.
    const liveTunnel = getTunnel();
    if (liveTunnel) {
      const liveness = checkPodLiveness(liveTunnel, `session-${sessionId}`);
      if (!liveness.executable) {
        process.stderr.write(`${deadPodAdvisory(sessionId, liveness.phase)}\n`);
        return { failed: 0 };
      }
    }
    if (opts.authRefresh !== false) {
      await preflightOrWarn(profile);
    }
    const previous = hashes.get(sessionId);
    const result = await softRefreshSession(sessionId, profile, {
      skipIfUnchanged: true,
      ...(previous !== undefined ? { previousHash: previous } : {}),
    });
    hashes.set(sessionId, result.hash);
    // Slice 2: ADDITIONAL trigger — pod-side 401 probe→push for gh/npm/docker.
    try {
      const actions = await probePodCredHealth(sessionId);
      for (const a of actions) {
        if (!a.health.ok) {
          process.stderr.write(
            `[remote]   ${sessionId}: ${a.health.reason}${a.pushed ? " — pushed" : ""}\n`,
          );
        }
      }
    } catch (probeError) {
      process.stderr.write(
        `[remote]   ${sessionId}: tool health probe skipped: ${String(probeError).slice(0, 120)}\n`,
      );
    }
    // Slice 3: ADDITIONAL trigger — plugin/MCP drift reconcile (manifest hash
    // mismatch → re-run the EXISTING buildPodSyncScript). Best-effort.
    try {
      reconcileSessionPlugins(sessionId, profile);
    } catch (driftError) {
      process.stderr.write(
        `[remote]   ${sessionId}: plugin drift reconcile skipped: ${String(driftError).slice(0, 120)}\n`,
      );
    }
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
        trackItemNewArgs(trackWp, {
          id: job.id,
          ...(job.task !== undefined ? { task: job.task } : {}),
        }),
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
      const remoteArgs = buildRemoteDelegate(job.tool, task, headless, job.model, job.effort);
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
    argv = buildDelegateArgs(job.tool, task, headless, job.model, job.effort);
  } catch (err) {
    return { started: false, error: (err as Error).message };
  }
  let runCwd: string;
  let isolated: boolean;
  try {
    ({ runCwd, isolated } = resolveJobCwd(originCwd, job.id, {
      ...(job.explicitCwd !== undefined
        ? { explicitCwd: job.explicitCwd }
        : {}),
    }));
  } catch (err) {
    return { started: false, error: (err as Error).message };
  }

  // Account-pool credential injection (WP16 Layer-C).
  // For claude-code and codex jobs, select the best available account and inject
  // its credential before spawning. tmux inherits process.env, so we set/restore
  // around the spawn (same pattern as DEPTH_ENV). agy has no pool → skip.
  // If no accounts are enrolled or all are exhausted, we proceed with existing env.
  const accountEnvOverrides: Record<string, string> = {};
  if (job.tool === "claude" || job.tool === "codex") {
    const preferredProvider: AccountProvider = job.tool === "claude" ? "claude-code" : "codex";
    const sel = selectAccountWithFallback(preferredProvider, job.id);
    if (!("allExhausted" in sel) && sel.candidate !== undefined) {
      if (sel.crossProvider) {
        const msg =
          `[remote] account-pool: all ${preferredProvider} accounts exhausted — ` +
          `falling back to ${sel.candidate.provider} (${sel.candidate.label})`;
        process.stderr.write(msg + "\n");
        // Notify the current tmux pane (non-blocking, best-effort).
        if (process.env.TMUX) {
          spawnSync("tmux", ["display-message", msg], { stdio: "ignore" });
        }
      }
      stickyBind(job.id, sel.candidate.id, sel.candidate.provider);
      // Append a line to the local session log for audit / future S3 export.
      appendSessionLogEntry({
        jobId: job.id,
        preferredProvider,
        selectedProvider: sel.candidate.provider,
        accountId: sel.candidate.id,
        accountLabel: sel.candidate.label,
        crossProvider: sel.crossProvider,
      });
      if (sel.candidate.provider === "codex") {
        accountEnvOverrides["OPENAI_API_KEY"] = sel.candidate.accessToken;
      } else if (sel.candidate.provider === "claude-code" && sel.candidate.configDir) {
        accountEnvOverrides["CLAUDE_CONFIG_DIR"] = sel.candidate.configDir;
      }
    }
    // allExhausted: proceed with existing env (fail gracefully at the CLI level)
  }

  // Propagate the child's remaining spawn-depth budget through the env so a job
  // that itself runs `remote delegate` inherits a DECREMENTED budget (depth=0 →
  // refuse). tmux inherits the spawning process's env, so set it around spawn.
  // ALSO stamp REMOTE_JOB_ID (H1): the spawned agent's claude SessionStart/End
  // hooks read it to resolve THIS job (they only get claude's conversation uuid,
  // not the job slug), so an interactive tmux job actually completes.
  const prevDepth = process.env[DEPTH_ENV];
  const prevJobId = process.env[JOB_ID_ENV];
  const prevAccountEnvs: Record<string, string | undefined> = {};
  process.env[DEPTH_ENV] = childDepthEnvValue(
    job.depthBudget ?? clampDepth(undefined),
  );
  process.env[JOB_ID_ENV] = job.id;
  for (const [k, v] of Object.entries(accountEnvOverrides)) {
    prevAccountEnvs[k] = process.env[k];
    process.env[k] = v;
  }
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
    for (const [k, prev] of Object.entries(prevAccountEnvs)) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
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

/**
 * Reliability slice 1 — RESUME a throttled HEADLESS LOCAL job. Relaunch the SAME
 * job in the SAME `runCwd` it already ran in (its recorded `cwd` — NOT a fresh
 * worktree, so it continues the prior conversation in place) with the tool's
 * CONTINUE flag (`claude -p --continue` / `codex exec resume --last`, via the
 * safe argv `buildThrottleResumeArgs` — never `bash -lc` concat), redirecting to
 * the SAME result.json/output.log, then transition `throttled → running`. The
 * throttle bookkeeping is PRESERVED so a re-throttle bumps `attempts` (the cap is
 * enforced in reconcile). Never throws — a spawn error is returned as
 * `{started:false}` so the conductor keeps going.
 *
 * SCOPE: headless local only. Interactive resume (send-keys) and remote resume
 * (control-plane) are phase 2 — see the TODOs at the call site.
 */
export function resumeThrottledJob(job: RegistryEntry): StartJobResult {
  if (job.kind !== "local-tmux" || job.headless !== true) {
    return {
      started: false,
      error: "throttle-resume is headless-local only (phase 1)",
    };
  }
  if (!tmuxAvailable()) {
    return { started: false, error: "tmux is not installed locally" };
  }
  const task = job.task ?? "";
  const originCwd = job.originCwd ?? process.cwd();
  // The job's recorded `cwd` IS the runCwd it ran in (the worktree, or the
  // explicit/origin dir). Resume in the SAME tree — continue, don't re-isolate.
  const runCwd = job.cwd;
  let argv: { command: string; args: string[] };
  try {
    argv = buildThrottleResumeArgs(job.tool, task);
  } catch (err) {
    return { started: false, error: (err as Error).message };
  }

  // Same env plumbing as startJob (depth budget + REMOTE_JOB_ID for the hooks).
  const prevDepth = process.env[DEPTH_ENV];
  const prevJobId = process.env[JOB_ID_ENV];
  process.env[DEPTH_ENV] = childDepthEnvValue(
    job.depthBudget ?? clampDepth(undefined),
  );
  process.env[JOB_ID_ENV] = job.id;
  let tmuxSession: string;
  try {
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
  } catch (err) {
    return { started: false, error: (err as Error).message };
  } finally {
    if (prevDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prevDepth;
    if (prevJobId === undefined) delete process.env[JOB_ID_ENV];
    else process.env[JOB_ID_ENV] = prevJobId;
  }

  // throttled → running, keeping the throttle bookkeeping (attempts/firstAt) so a
  // re-throttle on the resumed run accumulates toward the cap. Atomic.
  const advanced = advanceJob(job.id, "running");
  if (!advanced) {
    return {
      started: false,
      error: "could not transition throttled → running",
    };
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
    originCwd,
    ...(job.task !== undefined ? { task: job.task } : {}),
    ...(job.callbackTo !== undefined ? { callbackTo: job.callbackTo } : {}),
    ...(job.throttle !== undefined ? { throttle: job.throttle } : {}),
  });
  return { started: true, target: "local", detail: `${runCwd} [resume]` };
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
    ? withOpt
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
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
  gemini: "gemini",
  "gemini-cli": "gemini",
  mistral: "mistral",
  mistralcli: "mistral",
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
  if (
    shouldShowProfileMenu(
      argv,
      process.stdin.isTTY === true && process.stdout.isTTY === true,
    )
  ) {
    const profile = await promptProfileMenu(
      process.stdin,
      process.stderr,
      process.cwd(),
    );
    if (!profile) {
      process.stderr.write("[remote] no profile selected\n");
      return 1;
    }
    return main([
      argv[0] ?? "node",
      argv[1] ?? "remote",
      "run",
      profile,
      process.cwd(),
      "--attach",
    ]);
  }

  const program = new Command();
  program
    .name("remote")
    .description(
      "Wrap a local agent CLI (codex/claude/agy/gemini/mistral) and expose its session for remote attach.",
    )
    .version("0.0.0");

  for (const [profileName, alias] of [
    ["codex", undefined],
    ["claude", "claude-code"],
    ["agy", "antigravity"],
    ["gemini", "gemini-cli"],
    ["mistral", "mistralcli"],
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
      .option(
        "--browser",
        "add the headful-browser noVNC sidecar (WP7) — enables 2FA / authenticated-site flows from inside the pod",
      )
      .action(
        async (commandArgs: string[] | undefined, opts: ProfileCliOpts) => {
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
        },
      );
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
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
      process.stdout.write(["ID\tCREATED\tDISPLAY", ...rows].join("\n") + "\n");
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
        process.stderr.write(
          `[remote] pushed ${cwd} to ${marker.workspaceId}\n`,
        );
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
          process.stderr.write(
            `[remote] pulled ${marker.workspaceId} into ${cwd}\n`,
          );

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
      },
    );

  workspaceCommand
    .command("rm [workspaceId]")
    .description(
      "Delete a workspace (defaults to the cwd's mapped workspace) and its retained volume",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .action(
      async (workspaceId: string | undefined, opts: { remote?: string }) => {
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
      },
    );

  workspaceCommand
    .command("gc")
    .description(
      "Garbage-collect stale workspace directories on the shared remote volume (dry-run unless --apply)",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
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
    .description(
      "Inspect and manage the local CLI credentials remote sends to sessions",
    );

  const printAuthStatus = async (
    profile: CliProfile,
    opts: AuthDiagnosticOpts,
  ): Promise<void> => {
    const result = await inspectProfileAuth(profile, {
      ...(opts.authRefresh !== undefined
        ? { authRefresh: opts.authRefresh }
        : {}),
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
            `Unknown profile "${profileName}". Known: ${KNOWN_PROFILE_HELP}`,
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
          `Unknown profile "${profileName}". Known: ${KNOWN_PROFILE_HELP}`,
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
            opts.profile ??
            (await getRemoteSession(url, sessionId)).session.profile;
          const resolved = coerceCliProfileName(profile);
          if (!resolved) throw new Error(`Unknown profile "${profile}"`);
          if (opts.authRefresh !== false) {
            const fresh = await ensureProfileAuthFresh(resolved);
            if (fresh.checked)
              process.stderr.write(
                `[remote] auth status ok: ${fresh.command}\n`,
              );
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
        `Unknown profile "${profileName}". Known: ${KNOWN_PROFILE_HELP}`,
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
          : list
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
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
      if (tools.length > 0)
        process.stdout.write(`tools: ${tools.join(", ")}\n`);
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
    .requiredOption(
      "--namespace <ns>",
      "namespace of the control-plane service",
    )
    .requiredOption("--service <svc>", "control-plane Service name")
    .option("--kubeconfig <path>", "kubeconfig path (~ is expanded)")
    .option(
      "--local-port <port>",
      "local port",
      (v: string) => parseInt(v, 10),
      8080,
    )
    .option(
      "--remote-port <port>",
      "service port",
      (v: string) => parseInt(v, 10),
      8080,
    )
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .action(async (opts: { remote?: string }) => {
      const now = Date.now();
      const ACTIVE_MS = 10 * 60 * 1000;

      // Remote sessions + health, indexed by workspace path for correlation.
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      const remote = await listRemoteSessions(url);
      const health = new Map<string, string>();
      for (const s of remote)
        health.set(s.id, await sessionTerminalHealth(url, s.id));
      const remoteByPath = new Map<string, (typeof remote)[number]>();
      for (const s of remote)
        if (s.workspacePath) remoteByPath.set(s.workspacePath, s);
      const mark = (id: string): string => {
        const h = health.get(id);
        return h === "ready"
          ? "● ready"
          : h === "agent-down"
            ? "○ down"
            : "? unknown";
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
      process.stdout.write(
        "\nLOCAL tool auth (deport with --with / 'config tools'):\n",
      );
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .action(
      async (sessionId: string | undefined, opts: { remote?: string }) => {
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
          process.stdout.write(
            `Secrets transmitted to ${sessionId} (live, names only):\n`,
          );
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
      },
    );

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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .action(
      async (
        sessionId: string | undefined,
        opts: { session?: boolean; files?: boolean; remote?: string },
      ) => {
        if (opts.session && opts.files) {
          process.stderr.write(
            "[remote] --session and --files are mutually exclusive\n",
          );
          process.exitCode = 1;
          return;
        }
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        const all = await listRemoteSessions(url);
        const sessions = sessionId
          ? all.filter((s) => s.id === sessionId)
          : all;
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--watch",
      "repeat the sync on a loop (Ctrl-C to stop)",
    )
    .option(
      "--interval <seconds>",
      "seconds between sync passes in --watch mode (default: 30)",
      (v: string) => Number(v),
    )
    .action(
      async (
        sessionId: string,
        opts: {
          session?: string;
          files?: boolean;
          force?: boolean;
          remote?: string;
          watch?: boolean;
          interval?: number;
        },
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
        const session = (await listRemoteSessions(url)).find(
          (s) => s.id === sessionId,
        );
        if (!session?.workspacePath) {
          process.stderr.write(
            `[remote] no session ${sessionId} with a workspace path\n`,
          );
          process.exitCode = 1;
          return;
        }
        const workspacePath = session.workspacePath;

        const runOnce = () => {
          const result = syncConversation({
            sessionId,
            workspacePath,
            direction,
            force: opts.force ?? false,
          });
          if (!result.ok) {
            process.stderr.write(`[remote] refused: ${result.reason}\n`);
            return false;
          }
          if (result.backup) {
            process.stderr.write(`[remote] backup: ${result.backup}\n`);
          }
          const lines =
            direction === "pull" ? result.lines.remote : result.lines.local;
          const mode = result.incremental ? " [incremental]" : "";
          process.stderr.write(
            `[remote] ${direction === "pull" ? "pulled" : "pushed"} ${result.convId} (${lines} lines) → ${result.written}${mode}\n`,
          );
          if (direction === "push") {
            process.stderr.write(
              `[remote] not relaunching the Pod CLI — relance la session pour charger : remote refresh ${sessionId} --soft\n`,
            );
          }
          return true;
        };

        if (opts.watch) {
          const intervalSec = opts.interval ?? 30;
          process.stderr.write(
            `[remote] sync --watch: syncing every ${intervalSec}s (Ctrl-C to stop)\n`,
          );
          let stopped = false;
          let wake: (() => void) | undefined;
          const onSigint = () => {
            stopped = true;
            wake?.();
          };
          process.on("SIGINT", onSigint);
          try {
            while (!stopped) {
              process.stderr.write(
                `[remote] sync pass — ${new Date().toISOString()}\n`,
              );
              try {
                runOnce();
              } catch (err) {
                process.stderr.write(
                  `[remote] sync pass error: ${(err as Error).message}\n`,
                );
              }
              if (stopped) break;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, intervalSec * 1000);
                wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
              wake = undefined;
            }
          } finally {
            process.removeListener("SIGINT", onSigint);
          }
          process.stderr.write("[remote] sync --watch stopped\n");
          return;
        }

        const ok = runOnce();
        if (!ok) process.exitCode = 1;
      },
    );

  // ---------------------------------------------------------------------------
  // sync-status — Phase B3: show the local sync status for the current session
  // ---------------------------------------------------------------------------

  program
    .command("sync-status")
    .description("show sync status for the current session (reads ~/.remote/sync-status/<sessionId>.json)")
    .option("--json", "output raw JSON")
    .option("--session <id>", "session id (defaults to .remote/workspace.json marker)")
    .action(
      (opts: { json?: boolean; session?: string }) => {
        const marker = readWorkspaceMarker(process.cwd());
        const sessionId = opts.session ?? marker?.workspaceId;
        let status: SyncStatus;
        if (!sessionId) {
          // No session — synthesize a synced/safe-to-close placeholder
          status = {
            state: "synced",
            safeToClose: true,
            updatedAt: new Date().toISOString(),
            conv: emptyMetrics(),
            hot: emptyMetrics(),
            cold: emptyMetrics(),
          };
        } else {
          const persisted = readSyncStatus(sessionId);
          if (!persisted) {
            // No status file yet — unknown state. Default to pending/not-safe
            // (conservative): if even 1 byte of delta hasn't been ack'd, SAFE
            // TO CLOSE would be a false positive. The sync loop writes the file
            // on its first successful round-trip, so this only fires before the
            // first ack.
            status = {
              state: "pending",
              safeToClose: false,
              updatedAt: new Date().toISOString(),
              conv: emptyMetrics(),
              hot: emptyMetrics(),
              cold: emptyMetrics(),
            };
          } else {
            status = persisted;
          }
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(status, null, 2) + "\n");
          return;
        }

        // Human-readable output
        const safeLabel = status.safeToClose ? "YES" : "NO";
        const fmtMetrics = (label: string, m: typeof status.conv): string => {
          if (m.pendingCount === 0) return `  ${label.padEnd(6)} synced`;
          const kb = (m.pendingBytes / 1024).toFixed(0);
          return (
            `  ${label.padEnd(6)} ${m.pendingCount === 0 ? "synced" : "pending"}` +
            `  ${m.pendingCount} files / ${kb} KB` +
            (m.oldestPendingAge > 0 ? `  oldest ${m.oldestPendingAge}s` : "") +
            (m.estimatedCatchup > 0 ? `  ETA ${m.estimatedCatchup}s` : "")
          );
        };
        process.stdout.write(`State: ${status.state}\n`);
        process.stdout.write(`Safe to close: ${safeLabel}\n`);
        process.stdout.write(fmtMetrics("Conv:", status.conv) + "\n");
        process.stdout.write(fmtMetrics("Hot:", status.hot) + "\n");
        process.stdout.write(fmtMetrics("Cold:", status.cold) + "\n");
      },
    );

  // ---------------------------------------------------------------------------
  // sync-files — Phase B2 incremental git-based file sync
  // ---------------------------------------------------------------------------

  program
    .command("sync-files")
    .description(
      "Push the current git workspace to the session pod incrementally (git bundle on first push, diff on subsequent). " +
        "Distinct from `remote sync` which syncs conversations.",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--session <id>",
      "session id to sync into (defaults to .remote/workspace.json marker)",
    )
    .option("--dry-run", "show what would be sent without uploading")
    .action(
      async (opts: {
        remote?: string;
        session?: string;
        dryRun?: boolean;
      }) => {
        const cwd = process.cwd();
        const { isGitRepo: checkGit, getHeadSha, buildGitBundle, buildIncrementalManifest, buildUntrackedTarball } =
          await import("./workspace-sync-incremental.js");

        if (!checkGit(cwd)) {
          process.stderr.write(
            "[remote] sync-files: current directory is not a git repo\n",
          );
          process.exitCode = 1;
          return;
        }

        const headSha = getHeadSha(cwd);
        if (!headSha) {
          process.stderr.write(
            "[remote] sync-files: cannot resolve HEAD — make at least one commit\n",
          );
          process.exitCode = 1;
          return;
        }

        const marker = readWorkspaceMarker(cwd);
        const remote = getConfiguredRemote(opts.remote ?? marker?.remote);
        // Resolve session id: explicit --session, or from marker
        const sessionId = opts.session ?? marker?.workspaceId;
        if (!sessionId) {
          process.stderr.write(
            "[remote] sync-files: no session id — pass --session or run `remote workspace link` first\n",
          );
          process.exitCode = 1;
          return;
        }

        await ensureConnected(remote);

        // Query CP for the known base commit.
        const baseRes = await fetch(
          `${remote.replace(/\/$/, "")}/sessions/${sessionId}/workspace/incremental/base`,
          { headers: authHeaders() },
        );
        let baseSha: string | null = null;
        if (baseRes.ok) {
          const baseJson = (await baseRes.json()) as { baseSha?: string | null };
          baseSha = baseJson.baseSha ?? null;
        }

        if (opts.dryRun) {
          if (baseSha) {
            process.stderr.write(
              `[remote] sync-files (dry-run): incremental push HEAD=${headSha} base=${baseSha}\n`,
            );
          } else {
            process.stderr.write(
              `[remote] sync-files (dry-run): bootstrap push HEAD=${headSha} (no base on CP)\n`,
            );
          }
          return;
        }

        if (!baseSha) {
          // Bootstrap: upload full git bundle.
          process.stderr.write(
            `[remote] sync-files: bootstrap — building git bundle (HEAD=${headSha})\n`,
          );
          const bundle = buildGitBundle(cwd);
          process.stderr.write(
            `[remote] sync-files: bundle ${(bundle.byteLength / 1024).toFixed(0)} KiB → ${sessionId}\n`,
          );
          const uploadRes = await fetch(
            `${remote.replace(/\/$/, "")}/sessions/${sessionId}/workspace/incremental/bundle`,
            {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                ...authHeaders(),
              },
              body: bundle as unknown as BodyInit,
            },
          );
          if (!uploadRes.ok) {
            throw new Error(
              `bundle upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
            );
          }
          // Record HEAD as the new base.
          const manifestRes = await fetch(
            `${remote.replace(/\/$/, "")}/sessions/${sessionId}/workspace/incremental`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...authHeaders(),
              },
              body: JSON.stringify({
                base: headSha,
                tracked: "",
                untrackedManifest: [],
                deleted: [],
                renames: [],
                modes: [],
              }),
            },
          );
          if (!manifestRes.ok) {
            throw new Error(
              `manifest record failed: ${manifestRes.status} ${manifestRes.statusText}`,
            );
          }
          process.stderr.write(
            `[remote] sync-files: bootstrap complete, base=${headSha}\n`,
          );
          const { writeSyncStatus, emptyMetrics: em } = await import("./sync-status.js");
          writeSyncStatus(sessionId, {
            state: "synced",
            safeToClose: true,
            updatedAt: new Date().toISOString(),
            conv: em(),
            hot: em(),
            cold: em(),
          });
        } else {
          // Incremental push.
          process.stderr.write(
            `[remote] sync-files: incremental push base=${baseSha} → HEAD=${headSha}\n`,
          );
          const manifest = buildIncrementalManifest(cwd, baseSha);
          const untrackedPaths = manifest.untrackedManifest.map((e) => e.path);
          const trackedBytes = Buffer.from(manifest.tracked, "base64").byteLength;
          process.stderr.write(
            `[remote] sync-files: tracked diff ${(trackedBytes / 1024).toFixed(1)} KiB, ${untrackedPaths.length} untracked file(s)\n`,
          );

          // Upload manifest.
          const manifestRes = await fetch(
            `${remote.replace(/\/$/, "")}/sessions/${sessionId}/workspace/incremental`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...authHeaders(),
              },
              body: JSON.stringify(manifest),
            },
          );
          if (!manifestRes.ok) {
            throw new Error(
              `manifest upload failed: ${manifestRes.status} ${manifestRes.statusText}`,
            );
          }

          // Upload untracked tarball if any.
          if (untrackedPaths.length > 0) {
            const tarball = buildUntrackedTarball(cwd, untrackedPaths);
            const tarRes = await fetch(
              `${remote.replace(/\/$/, "")}/sessions/${sessionId}/workspace/incremental/untracked`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/gzip",
                  ...authHeaders(),
                },
                body: tarball as unknown as BodyInit,
              },
            );
            if (!tarRes.ok) {
              throw new Error(
                `untracked upload failed: ${tarRes.status} ${tarRes.statusText}`,
              );
            }
          }

          process.stderr.write(
            `[remote] sync-files: incremental complete, base=${headSha}\n`,
          );
          const { writeSyncStatus: wss, emptyMetrics: em2 } = await import("./sync-status.js");
          wss(sessionId, {
            state: "synced",
            safeToClose: true,
            updatedAt: new Date().toISOString(),
            conv: em2(),
            hot: em2(),
            cold: em2(),
          });
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
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
            process.stderr.write(
              `[remote] invalid local port "${localPort}"\n`,
            );
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
          if (
            !Number.isInteger(localPort) ||
            localPort < 1 ||
            localPort > 65535
          ) {
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
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
            : opts.resume === true && coerceCliProfileName(profile) === "claude"
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--workspace <id>",
      "workspace id to pull (defaults to .remote/workspace.json)",
    )
    .option(
      "--on-conflict <mode>",
      "conflict resolution for diverged conversations: backup | keep-local (default: block)",
    )
    .option(
      "--lineage <id>",
      "lineage id to find the right remote session (lin_…); when set, the session matching this lineage is targeted instead of the most-recent one",
    )
    .action(
      async (opts: {
        remote?: string;
        workspace?: string;
        onConflict?: string;
        lineage?: string;
      }) => {
        const remoteUrl = getConfiguredRemote(opts.remote);
        const onConflict =
          opts.onConflict === "backup"
            ? ("backup" as const)
            : opts.onConflict === "keep-local"
              ? ("keep-local" as const)
              : ("block" as const);
        // --lineage: if provided, find the workspace and session that matches
        let workspaceId = opts.workspace;
        let knownSessionId: string | undefined;
        if (opts.lineage) {
          const lineageId = opts.lineage as LineageId;
          const lineages = listLineages(process.cwd());
          const match = lineages.find((l) => l.lineage === lineageId);
          if (match) {
            const lastWs = match.wsHistory[match.wsHistory.length - 1];
            if (lastWs && !workspaceId) {
              process.stderr.write(
                `[remote] --lineage ${lineageId} → workspace history includes ${lastWs}\n`,
              );
            }
            if (match.incarnation.remote?.sessionId) {
              knownSessionId = match.incarnation.remote.sessionId;
              process.stderr.write(
                `[remote] targeting session ${knownSessionId} (from lineage)\n`,
              );
            }
          } else {
            process.stderr.write(
              `[remote] warning: lineage ${lineageId} not found locally; proceeding without lineage filter\n`,
            );
          }
        }
        await migrateBack({
          remoteUrl,
          ...(workspaceId ? { workspaceId } : {}),
          ...(knownSessionId ? { sessionId: knownSessionId } : {}),
          onConflict,
        });
      },
    );

  migrateCommand
    .command("to-remote [profile]")
    .description(
      "Phase A — migrate the current session to a remote k8s session, with lineage tracking and readiness check. " +
        "Extends `migrate forward`: checks readiness, creates/reuses a lineage, acquires the lease, " +
        "suspends the local incarnation, then delegates to `migrate forward` for the actual transfer.",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--slug <name>",
      "tmux slug for the local incarnation id (defaults to cwd basename)",
    )
    .option(
      "--dry-run",
      "check readiness and plan the migration without executing it",
    )
    .option(
      "--with <tools>",
      `comma-separated tool CLIs whose local auth to also bundle (known: ${KNOWN_TOOLS.join(", ")})`,
    )
    .action(
      async (
        profile: string | undefined,
        opts: {
          remote?: string;
          slug?: string;
          dryRun?: boolean;
          with?: string;
        },
      ) => {
        const cwd = process.cwd();
        const resolvedProfile = profile ?? "claude";

        // Step 1: checkReadiness
        const readiness = checkReadiness({ cwd, profile: resolvedProfile });
        if (readiness.blockers.length > 0) {
          process.stderr.write(
            `[remote] migration blocked:\n${readiness.blockers.map((b) => `  • ${b}`).join("\n")}\n`,
          );
          process.exitCode = 1;
          return;
        }
        if (readiness.warnings.length > 0) {
          process.stderr.write(
            `[remote] readiness warnings:\n${readiness.warnings.map((w) => `  ⚠ ${w}`).join("\n")}\n`,
          );
        }
        process.stderr.write(
          `[remote] readiness ok (mode: ${readiness.mode}, pending: ${readiness.pending.files} files / ${(readiness.pending.bytes / 1024).toFixed(0)} KiB)\n`,
        );

        // Step 2: compute durable workspace id (best-effort)
        let wsHex = "ws:unknown";
        try {
          const git = (args: string[]) =>
            spawnSync("git", args, {
              cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
          const roots = git(["rev-list", "--max-parents=0", "HEAD"]);
          if (roots.status === 0) {
            const rootCommitSHA = normalizeRootCommits(
              roots.stdout.split("\n"),
            );
            if (rootCommitSHA) {
              const dir = git(["rev-parse", "--git-dir"]);
              const common = git(["rev-parse", "--git-common-dir"]);
              const dirPath = dir.status === 0 ? dir.stdout.trim() : "";
              const commonPath =
                common.status === 0 ? common.stdout.trim() : "";
              const worktreeRelPath =
                dirPath && commonPath && dirPath !== commonPath
                  ? basename(dirPath)
                  : "";
              wsHex = computeDurableWorkspaceId(rootCommitSHA, worktreeRelPath);
            }
          }
        } catch {
          // best-effort: use placeholder
        }

        // Step 3: create or reuse a lineage for this workspace+profile
        const existingLineages = listLineages(cwd);
        const existingLineage = existingLineages.find(
          (l) =>
            l.profile === resolvedProfile &&
            l.wsHistory.includes(wsHex) &&
            l.incarnation.remote === null,
        );
        const lineageRecord =
          existingLineage ?? createLineage(resolvedProfile, "local", wsHex, cwd);
        const lineageId = lineageRecord.lineage;

        // Step 4: acquire lease for this local incarnation
        const localSlug = opts.slug ?? basename(cwd);
        const thisInstance = `claude:local:${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const TTL_MS = 300_000; // 5 minutes
        const leaseResult = acquireLease(
          lineageId,
          thisInstance,
          localSlug,
          "local",
          TTL_MS,
          cwd,
        );
        if ("error" in leaseResult) {
          process.stderr.write(
            `[remote] lease conflict: lineage ${lineageId} is held by ${leaseResult.current.holder} (${leaseResult.current.location}) until ${leaseResult.current.expiresAt}\n` +
              `[remote] wait for the lease to expire or use \`remote migrate to-remote --force\` (not yet implemented)\n`,
          );
          process.exitCode = 1;
          return;
        }

        process.stderr.write(
          `[remote] lineage: ${lineageId} (epoch ${leaseResult.epoch}, holder ${thisInstance})\n`,
        );

        if (opts.dryRun) {
          process.stderr.write(
            `[remote] --dry-run: would call migrate forward ${resolvedProfile} (mode: ${readiness.mode})\n`,
          );
          process.stderr.write(
            `[remote] dry-run complete — no session created, lease NOT handed off\n`,
          );
          // Release the lease on dry-run (we only acquired it to check)
          return;
        }

        // Step 5: suspend local incarnation BEFORE handoff
        suspendLocalIncarnation(lineageId, cwd);
        process.stderr.write(
          `[remote] local incarnation suspended (sentinel written)\n`,
        );

        // Step 6: call existing migrate forward
        const remoteUrl = getConfiguredRemote(opts.remote);
        await ensureConnected(remoteUrl);
        const tools = resolveTools(opts.with);
        let sessionId: string | undefined;
        try {
          const result = await migrateForward({
            profile: resolvedProfile,
            remoteUrl,
            resume: true,
            noAttach: false,
            ...(tools.length > 0 ? { tools } : {}),
          });
          sessionId = result.sessionId;
        } catch (err) {
          // On error: resume local incarnation (undo suspend)
          resumeLocalIncarnation(lineageId, cwd);
          process.stderr.write(
            `[remote] migrate forward failed: ${(err as Error).message}\n` +
              `[remote] local incarnation resumed\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Step 7: hand off lease to remote holder + persist remote incarnation
        const remoteHolder = `remote:pod:${sessionId ?? "unknown"}`;
        const handoffResult = handoffLease(
          lineageId,
          thisInstance,
          leaseResult.epoch,
          remoteHolder,
          sessionId ?? "unknown",
          "remote",
          TTL_MS,
          cwd,
        );
        if ("error" in handoffResult) {
          process.stderr.write(
            `[remote] warning: lease handoff failed (${handoffResult.error}) — lease may be stale\n`,
          );
        } else {
          process.stderr.write(
            `[remote] lease handed off to remote (epoch ${handoffResult.epoch})\n`,
          );
        }
        // Persist remote session id in the lineage record so `migrate back
        // --lineage <id>` can target it without listing all sessions.
        if (sessionId) {
          try {
            updateLineage(
              lineageId,
              {
                incarnation: {
                  local: null,
                  remote: { sessionId },
                },
              },
              cwd,
            );
          } catch {
            // best-effort: lineage may not exist yet on first migration
          }
        }

        // Step 8: summary
        process.stderr.write(
          `[remote] migration complete:\n` +
            `  lineage:  ${lineageId}\n` +
            `  session:  ${sessionId ?? "unknown"}\n` +
            `  remote:   ${remoteUrl}\n`,
        );
      },
    );

  migrateCommand
    .command("to-local")
    .description(
      "Phase A — migrate the current remote session back to local, with lineage tracking. " +
        "Extends `migrate back`: finds the active remote lineage, acquires the local lease, " +
        "then delegates to `migrate back` for the actual transfer.",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--slug <remoteSlug>",
      "remote session slug/id to migrate back (defaults to the active remote lineage)",
    )
    .option(
      "--dry-run",
      "check readiness and plan the migration without executing it",
    )
    .option(
      "--on-conflict <mode>",
      "conflict resolution for diverged conversations: backup | keep-local (default: block)",
    )
    .action(
      async (opts: {
        remote?: string;
        slug?: string;
        dryRun?: boolean;
        onConflict?: string;
      }) => {
        const cwd = process.cwd();

        // Step 1: checkReadiness (auth, repo)
        const readiness = checkReadiness({ cwd });
        const authBlocker = readiness.blockers.find((b) =>
          b.startsWith("auth:"),
        );
        const repoBlocker = readiness.blockers.find((b) =>
          b.startsWith("repo:"),
        );
        const toLocalBlockers = [authBlocker, repoBlocker].filter(
          (b): b is string => b !== undefined,
        );
        if (toLocalBlockers.length > 0) {
          process.stderr.write(
            `[remote] migration blocked:\n${toLocalBlockers.map((b) => `  • ${b}`).join("\n")}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Step 2: find active remote lineage
        const lineages = listLineages(cwd);
        const remoteLineage = lineages.find(
          (l) => l.incarnation.remote !== null,
        );
        if (!remoteLineage) {
          process.stderr.write(
            `[remote] no active remote lineage found in ${cwd}/.remote/lineages/\n` +
              `[remote] run \`remote migrate to-remote\` first, or check \`ls .remote/lineages/\`\n`,
          );
          process.exitCode = 1;
          return;
        }
        const lineageId = remoteLineage.lineage;
        process.stderr.write(
          `[remote] found remote lineage ${lineageId} (session ${remoteLineage.incarnation.remote?.sessionId ?? "unknown"})\n`,
        );

        // Step 3: try to acquire the local lease
        const localSlug = basename(cwd);
        const thisInstance = `claude:local:${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const TTL_MS = 300_000;
        const leaseResult = acquireLease(
          lineageId,
          thisInstance,
          localSlug,
          "local",
          TTL_MS,
          cwd,
        );
        if ("error" in leaseResult) {
          const current = leaseResult.current;
          if (current.location === "remote") {
            process.stderr.write(
              `[remote] un agent remote tient le lease ; attendez l'expiry (${current.expiresAt}) ou utilisez \`remote migrate to-local --force\` pour forcer\n`,
            );
          } else {
            process.stderr.write(
              `[remote] lease conflict: held by ${current.holder} until ${current.expiresAt}\n`,
            );
          }
          process.exitCode = 1;
          return;
        }

        process.stderr.write(
          `[remote] lease acquired (epoch ${leaseResult.epoch}, holder ${thisInstance})\n`,
        );

        if (opts.dryRun) {
          process.stderr.write(
            `[remote] --dry-run: would call migrate back (lineage ${lineageId})\n`,
          );
          process.stderr.write(
            `[remote] dry-run complete — no session stopped, lease NOT committed\n`,
          );
          return;
        }

        // Step 4: reset suspend sentinel (local incarnation resumes)
        resumeLocalIncarnation(lineageId, cwd);
        process.stderr.write(
          `[remote] local incarnation resumed (sentinel cleared)\n`,
        );

        // Step 5: call existing migrate back
        const remoteUrl = getConfiguredRemote(opts.remote);
        const onConflict =
          opts.onConflict === "backup"
            ? ("backup" as const)
            : opts.onConflict === "keep-local"
              ? ("keep-local" as const)
              : ("block" as const);
        try {
          await migrateBack({
            remoteUrl,
            onConflict,
          });
        } catch (err) {
          process.stderr.write(
            `[remote] migrate back failed: ${(err as Error).message}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Step 6: summary
        process.stderr.write(
          `[remote] to-local complete (lineage ${lineageId})\n`,
        );
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
        '--curl <url> / --install "<shell>": a NON-npm tool, installed in each Pod on sync by piping an https script or running a shell command (e.g. a Go binary\'s install.sh). ' +
        "Without --mcp, every npm bin ending in -mcp is registered (track-mcp -> track), as `node <realpath>`.",
    )
    .option(
      "--mcp <name=bin>",
      "MCP server to register, as <name>=<bin> (repeatable; overrides the -mcp heuristic)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option(
      "--curl <url>",
      "install in Pods via `curl -fsSL <url> | bash` (non-npm)",
    )
    .option(
      "--install <shell>",
      "install in Pods by running this shell command (non-npm)",
    )
    .action(
      (
        pkgOrName: string,
        opts: { mcp: string[]; curl?: string; install?: string },
      ) => {
        if (opts.curl !== undefined && opts.install !== undefined) {
          process.stderr.write(
            "[remote] pass only one of --curl / --install\n",
          );
          process.exitCode = 1;
          return;
        }
        if (opts.curl !== undefined) {
          pluginAddInstaller(pkgOrName, { method: "curl", spec: opts.curl });
        } else if (opts.install !== undefined) {
          pluginAddInstaller(pkgOrName, {
            method: "script",
            spec: opts.install,
          });
        } else {
          pluginAdd(pkgOrName, opts.mcp);
        }
      },
    );

  pluginCommand
    .command("ls")
    .description(
      "List configured plugins: pkg, version, MCP servers, and where they are installed (local ok/missing; REMOTE = real per-Pod drift status when connected, else ?)",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--no-remote-check",
      "skip the live per-Pod drift probe (offline; REMOTE shows ?)",
    )
    .action(async (opts: { remote?: string; remoteCheck?: boolean }) => {
      // Real REMOTE status needs a connected control-plane + tunnel; offline it
      // falls back to `?`. --no-remote-check forces the offline/fast path.
      if (opts.remoteCheck === false) {
        await pluginLs();
        return;
      }
      let url: string | undefined;
      try {
        url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
      } catch {
        url = undefined; // not configured / can't connect → `?` fallback
      }
      await pluginLs(process.stdout, url);
    });

  pluginCommand
    .command("sync")
    .description(
      "Install every configured plugin into each live REMOTE session Pod (kubectl exec -> npm i -g) and register its MCP servers for the Pod's profile (claude/codex; others: TODO). " +
        "--check: do NOT converge — print a per-Pod drift report (ok/version-drift/missing/mcp-unregistered) and exit 1 on any drift. Needs the configured tunnel.",
    )
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .option(
      "--check",
      "read-only drift report (no convergence); exit 1 on any drift",
    )
    .action(async (opts: { remote?: string; check?: boolean }) => {
      const url = getConfiguredRemote(opts.remote);
      await ensureConnected(url);
      if (opts.check) {
        await pluginSyncCheck(url);
        return;
      }
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
    .option(
      "--remote <url>",
      "control-plane URL (defaults to configured remote)",
    )
    .action(
      async (opts: {
        pod?: string;
        all?: boolean;
        dryRun?: boolean;
        remote?: string;
      }) => {
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        const syncOpts: { pod?: string; all?: boolean; dryRun?: boolean } = {};
        if (opts.pod !== undefined) syncOpts.pod = opts.pod;
        if (opts.all !== undefined) syncOpts.all = opts.all;
        if (opts.dryRun !== undefined) syncOpts.dryRun = opts.dryRun;
        await syncSkills(url, syncOpts);
      },
    );

  program
    .command("run <profile> [path]")
    .description(
      "Start a LOCAL session in tmux (claude/codex/…) in <path> (default: cwd). Manage it like a remote one: `remote ls`, `remote attach <slug>`, `remote stop <slug>`. Detach with Ctrl-b d; the session keeps running.",
    )
    .option(
      "--attach",
      "attach immediately after starting (default: start detached)",
    )
    .option(
      "-r, --resume <convId>",
      "resume a specific conversation in the CLI",
    )
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
      'also start the h2a MCP server in a side tmux window "h2a" (launcher contract: agent reachable/wakeable via ~/h2a-workspace/.h2a); config key `h2a: {enabled, command}` makes it the default',
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
            process.stderr.write(
              `[remote] --count must be a whole number ≥ 1\n`,
            );
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
        if (opts.resume && args.length === 0) {
          process.stderr.write(
            `[remote] profile "${profile}" has no verified local resume argv; start it without -r/--resume\n`,
          );
          process.exitCode = 1;
          return;
        }
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
        process.stderr.write(
          `[remote] attach with: remote attach ${only.slug}\n`,
        );
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
    .option(
      "--model <model>",
      "model override for the spawned agent (claude: --model; codex: -m). E.g. claude-sonnet-4-6, claude-opus-4-8, o3.",
    )
    .option(
      "--effort <level>",
      "reasoning-effort override (claude only: --effort low|medium|high|xhigh|max). Silently ignored for non-claude types.",
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
          model?: string;
          effort?: string;
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
        const jobId =
          opts.name ?? `${jobType}-${Math.random().toString(36).slice(2, 8)}`;
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
          opts.maxDepth !== undefined
            ? Number.parseInt(opts.maxDepth, 10)
            : undefined;
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
            : (getMaxConcurrent() ?? DEFAULT_MAX_CONCURRENT);
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
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
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
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
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
          process.stderr.write(
            `[remote] failed to start job ${jobId}: ${result.error}\n`,
          );
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
    runTrackMirror(
      trackItemRealizeArgs({ id: job.id }),
      job.originCwd ?? process.cwd(),
    );
  };

  // Reliability slice 1 — read the LAST ~60 lines of a HEADLESS job's output.log
  // (under its ORIGIN cwd, like every other artifact). Best-effort: a missing /
  // unreadable log returns "" (→ no throttle). Bounded read for the tail only.
  const readJobLogTail = (job: RegistryEntry): string => {
    try {
      const logPath = join(
        jobDir(job.originCwd ?? process.cwd(), job.id),
        "output.log",
      );
      const full = readFileSync(logPath, "utf8");
      const lines = full.split(/\r?\n/);
      return lines
        .slice(Math.max(0, lines.length - THROTTLE_TAIL_LINES))
        .join("\n");
    } catch {
      return "";
    }
  };

  /**
   * Reliability slice 1 — classify a finished HEADLESS LOCAL job's tail and, on a
   * transient provider rate-limit, record the throttle (running → `throttled`
   * with attempt++/backoff `nextRetryAt`), OR fail it `rate-limited` once the
   * 6-attempt cap is spent. Returns true when it HANDLED the job (so reconcile
   * skips its normal terminal path), false when it was not a throttle.
   *
   * Mutates the registry under `withRegistryLock` (atomic transition + bookkeeping
   * in one critical section). On the terminal cap-exceeded path it emits the
   * best-effort `job.done` + realizes the track mirror, like the normal path.
   */
  const maybeRecordThrottle = (job: RegistryEntry): boolean => {
    const verdict = detectThrottle(readJobLogTail(job), job.tool);
    if (!verdict.throttled) return false;
    const nowMs = Date.now();
    const prior = job.throttle
      ? { attempts: job.throttle.attempts, firstAt: job.throttle.firstAt }
      : undefined;
    const step = planThrottleStep({
      prior,
      nowMs,
      // attempts is 0-based for the backoff (first throttle → attempt 0).
      delayMs: jitteredBackoffMs(prior?.attempts ?? 0),
      ...(verdict.signature !== undefined
        ? { signature: verdict.signature }
        : {}),
    });
    if (step.action === "fail") {
      const advanced = advanceJob(job.id, "failed");
      if (advanced) {
        process.stderr.write(
          `[remote] job ${job.id} (${job.tool}) failed: rate-limited ` +
            `(gave up after ${job.throttle?.attempts ?? THROTTLE_MAX_ATTEMPTS} resume attempts)\n`,
        );
        emitJobDone(advanced, { state: "failed" });
        realizeTrackMirror(advanced);
      }
      return true;
    }
    // running → throttled, persisting the backoff bookkeeping atomically.
    const info: ThrottleInfo = {
      attempts: step.attempts,
      firstAt: step.firstAt,
      nextRetryAt: step.nextRetryAt,
      ...(step.signature !== undefined
        ? { lastSignature: step.signature }
        : {}),
    };
    const path = resolveRegistryPath();
    const ok = withRegistryLock(path, (entries) => {
      const e = entries.find((x) => x.id === job.id && x.role === "job");
      if (!e || (e.jobState ?? "pending") !== "running") {
        return { entries, result: false, save: false };
      }
      e.jobState = "throttled";
      e.throttle = info;
      e.lastSeenAt = new Date(nowMs).toISOString();
      return { entries, result: true };
    });
    if (ok) {
      process.stderr.write(
        `[remote] job ${job.id} (${job.tool}) throttled (${verdict.signature ?? "rate-limited"}) — ` +
          `attempt ${step.attempts}/${THROTTLE_MAX_ATTEMPTS}, resume at ${step.nextRetryAt}\n`,
      );
    }
    return ok;
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
      // its non-liveness must NOT be read as a crash. A `throttled` job has
      // DELIBERATELY finished its run and is awaiting the conductor's backoff
      // resume — its non-liveness is expected, NOT a crash. Both are owned by the
      // conductor pass; skip them here (reliability slice 1).
      if (
        state === "pending" ||
        state === "throttled" ||
        state === "done" ||
        state === "failed"
      )
        continue;
      if (jobLive(job)) continue;
      // H2 — result.json was written under the job's ORIGIN cwd (HEADLESS_WRAPPER
      // → jobDir(originCwd)); a conductor running from a DIFFERENT cwd must read
      // it there, not at its own process.cwd() (which would always miss → force
      // `failed` on a successful exit). Same fix at every readJobResult site.
      const result = readJobResult(job.originCwd ?? process.cwd(), job.id);

      // Reliability slice 1 — RATE-LIMIT detection for HEADLESS LOCAL jobs. A
      // headless job that finished with a NON-success result may have hit a
      // transient provider rate-limit rather than a real failure. Read the tail
      // of its output.log and classify; on a throttle, transition to `throttled`
      // (keeping its slot) with backoff bookkeeping instead of failing it.
      //
      // TODO(phase-2): the same detection applies to INTERACTIVE tmux jobs (read
      // the pane via capturePane, nudge via send-keys behind an attached-pane
      // guard) and to REMOTE jobs (kubectl-exec/logs tail in reconcileRemoteJobs).
      // Both are deliberately OUT of this slice.
      if (
        job.headless === true &&
        job.kind === "local-tmux" &&
        (result === undefined || result.state === "failed")
      ) {
        // handled === true when the job was moved to `throttled` (awaiting the
        // backoff resume) OR failed with the rate-limited reason after the cap —
        // either way reconcile must not re-fail/re-emit it.
        const handled = maybeRecordThrottle(job);
        if (handled) continue;
      }

      const advanced = advanceJob(job.id, result?.state ?? "failed");
      if (advanced) {
        emitJobDone(advanced, {
          state: advanced.jobState ?? "failed",
          ...(result?.exitCode !== undefined
            ? { exitCode: result.exitCode }
            : {}),
        });
        realizeTrackMirror(advanced);
      }
    }
    // Remote: reconcile against the control-plane session list. Skip `pending`
    // (queued, no Pod yet) — only RUNNING remote jobs are checked against live.
    const remoteJobs = listJobs().filter(
      (j) => j.kind === "remote" && (j.jobState ?? "pending") === "running",
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
      // Slice 2 — creds reliability advisories (detection only, never act).
      const supWarn = supervisorStalenessAdvisory();
      if (supWarn) process.stderr.write(`${supWarn}\n`);
      const claudeWarn = localClaudeExpiryAdvisory();
      if (claudeWarn) process.stderr.write(`${claudeWarn}\n`);
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
      const logPath = join(
        jobDir(job.originCwd ?? process.cwd(), id),
        "output.log",
      );
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
      const envelope = buildDecisionReply({
        job,
        parentInstance: from,
        answer,
      });
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

  // Reliability slice 1 — the AIMD effective cap CARRIES ACROSS passes (the
  // conductor's `--watch` loop calls conductPass repeatedly). `undefined` on the
  // first pass means "start fully open at the configured cap".
  let aimdLastCap: number | undefined;

  // Collect recent throttle-event timestamps from the registry for the AIMD
  // breaker: each job that has a `throttle` record contributes its most recent
  // throttle moment — `lastSeenAt` while it is still `throttled` (the instant it
  // entered), else `throttle.firstAt`. The pure `aimdEffectiveCap` windows them.
  const recentThrottleEvents = (
    jobs: ReadonlyArray<RegistryEntry>,
  ): string[] => {
    const out: string[] = [];
    for (const j of jobs) {
      if (j.role !== "job" || !j.throttle) continue;
      out.push(
        (j.jobState ?? "pending") === "throttled"
          ? j.lastSeenAt
          : j.throttle.firstAt,
      );
    }
    return out;
  };

  // P4 — the CONDUCTOR. A single pass: (a) reconcile job state (consume finished
  // jobs → frees a slot + emits job.done + realizes the track mirror), (a') RESUME
  // throttled jobs whose backoff elapsed (reliability slice 1), (b) start
  // `pending` jobs while `running < effectiveCap`, via the SAME `startJob` path
  // delegate uses. The effectiveCap is the AIMD breaker's output (halve on a
  // throttle burst, restore +1 per clean pass). With `--watch <min>` it loops in
  // the FOREGROUND (dedicated tmux window, like `h2a bridge --watch`), no daemon.
  // SIGINT → clean exit 0.
  const conductPass = async (
    cap: number,
  ): Promise<{ started: number; finished: number }> => {
    const before = listJobs();
    const terminalBefore = before.filter(
      (j) => j.jobState === "done" || j.jobState === "failed",
    ).length;
    // (a) reconcile (also classifies throttles, emits job.done + realizes track
    // mirror on terminal). After this, freshly-throttled jobs are `throttled`.
    const after = await reconcileJobs();
    const terminalAfter = after.filter(
      (j) => j.jobState === "done" || j.jobState === "failed",
    ).length;
    const finished = Math.max(0, terminalAfter - terminalBefore);

    // (a') RESUME throttled jobs whose backoff window has elapsed (HEADLESS LOCAL
    // only). A resumed job goes throttled → running and re-occupies its slot; if
    // it throttles again, reconcile bumps `attempts` (cap enforced there).
    const nowMs = Date.now();
    let resumed = 0;
    for (const job of after) {
      if (job.role !== "job" || (job.jobState ?? "pending") !== "throttled")
        continue;
      if (!isThrottleResumeDue(job.throttle, nowMs)) continue;
      // TODO(phase-2): an interactive throttled job would resume via send-keys
      // (attached-pane guard), and a remote one via the control-plane — both out
      // of this slice; resumeThrottledJob refuses anything but headless-local.
      const r = resumeThrottledJob(job);
      if (r.started) {
        resumed += 1;
        process.stderr.write(
          `[remote] conduct: resumed throttled ${job.id} (${job.tool}) in ${r.detail}\n`,
        );
      } else {
        process.stderr.write(
          `[remote] conduct: could not resume throttled ${job.id}: ${r.error}\n`,
        );
      }
    }

    // AIMD effective cap: a provider rate-limit is account-wide, so admit FEWER
    // new pending jobs when throttles are bursting. Throttled/running jobs keep
    // their slots regardless (occupiesSlot); this only governs NEW admissions.
    const refreshed = listJobs();
    const effectiveCap = aimdEffectiveCap(
      cap,
      recentThrottleEvents(refreshed),
      nowMs,
      aimdLastCap,
    );
    aimdLastCap = effectiveCap;
    if (effectiveCap < cap) {
      process.stderr.write(
        `[remote] conduct: AIMD breaker — admitting up to ${effectiveCap}/${cap} (rate-limit pressure)\n`,
      );
    }

    // (b) start pending jobs under the EFFECTIVE cap (oldest-first FIFO).
    let started = 0;
    for (const id of planNextStarts(refreshed, effectiveCap)) {
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
    // Count a resume as "started" work for the pass recap.
    return { started: started + resumed, finished };
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
            : (getMaxConcurrent() ?? DEFAULT_MAX_CONCURRENT);
        const cap =
          Number.isFinite(capRaw) && capRaw > 0
            ? capRaw
            : DEFAULT_MAX_CONCURRENT;
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
      if (confirm)
        markLaunchEnvelopeProcessed(env.path, `skip: ${gate.reason}`);
      process.stderr.write(
        `[remote] conductor-launch: SKIP — ${gate.reason}\n`,
      );
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
      result.started
        ? `launched ${host} ${slug}`
        : `launch-failed: ${result.error}`,
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
      async (opts: {
        confirm?: boolean;
        watch?: string;
        cooldown?: string;
      }) => {
        const confirm = opts.confirm === true;
        const cooldownMin =
          opts.cooldown !== undefined ? Number(opts.cooldown) : 30;
        if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
          throw new Error(
            "--cooldown must be a non-negative number of minutes",
          );
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
  // wake-request — out-of-band Codex pane wake via h2a 0.72.0 wake-request
  // ---------------------------------------------------------------------------

  const WAKE_REQUEST_IDEMPOTENCE_MS = 60_000;

  /**
   * Parse a raw envelope object as a wake-request envelope.
   * Returns { target, reason } when the envelope matches, undefined otherwise.
   */
  function parseWakeRequestEnvelope(
    env: unknown,
  ): { target: string; reason: string } | undefined {
    if (!env || typeof env !== "object") return undefined;
    const root = env as Record<string, unknown>;
    const body = root.body;
    if (!body || typeof body !== "object") return undefined;
    const b = body as Record<string, unknown>;
    if (b.kind !== "message" || b.topic !== "wake-request") return undefined;
    const req = b.request;
    if (!req || typeof req !== "object") return undefined;
    const r = req as Record<string, unknown>;
    const target = r.target;
    if (typeof target !== "string" || target.length === 0) return undefined;
    return {
      target,
      reason: typeof r.reason === "string" ? r.reason : "",
    };
  }

  /**
   * Idempotence: read/write a per-target stamp file under the h2a root.
   * Returns the last wake epoch ms, or undefined when no stamp exists.
   * Best-effort: any fs error → undefined (allows the wake to proceed).
   */
  function readWakeStampMs(
    localRoot: string,
    target: string,
  ): number | undefined {
    try {
      const safeName = target.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const path = join(localRoot, `wake-stamp-${safeName}.json`);
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { wokenAt?: unknown };
      const at = parsed.wokenAt;
      return typeof at === "number" && Number.isFinite(at) ? at : undefined;
    } catch {
      return undefined;
    }
  }

  function writeWakeStampMs(
    localRoot: string,
    target: string,
    nowMs: number,
  ): void {
    try {
      const safeName = target.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const path = join(localRoot, `wake-stamp-${safeName}.json`);
      mkdirSync(localRoot, { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ wokenAt: nowMs, target })}\n`,
        "utf8",
      );
    } catch {
      // best-effort
    }
  }

  /**
   * Read every wake-request envelope under `<localRoot>/inbox/**` (one dir level
   * deep, the h2a layout) WITH their file paths, skipping already-processed ones
   * (sibling `.processed` stamp, same contract as readLaunchEnvelopes). Used to
   * support idempotent `.processed` marking after a successful wake.
   */
  const readWakeEnvelopeFiles = (
    localRoot: string,
  ): Array<{ path: string; env: unknown }> => {
    const inbox = join(localRoot, "inbox");
    if (!existsSync(inbox)) return [];
    const out: Array<{ path: string; env: unknown }> = [];
    for (const dir of readdirSync(inbox, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(inbox, dir.name);
      for (const f of readdirSync(dirPath, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".json")) continue;
        const path = join(dirPath, f.name);
        if (existsSync(`${path}.processed`)) continue; // already handled
        let raw: string;
        try {
          raw = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        try {
          out.push({ path, env: JSON.parse(raw) });
        } catch {
          // malformed JSON → skip
        }
      }
    }
    return out;
  };

  /**
   * One pass of the wake-request handler:
   *  1. Read all h2a inbox envelopes (with paths, skipping .processed ones).
   *  2. Filter those with topic === "wake-request".
   *  3. For each: idempotence check → resolve pane → send-keys instruction nudge
   *     → mark envelope .processed.
   * Returns the count of panes woken this pass.
   */
  const wakeRequestPass = (localRoot: string): number => {
    const envelopeFiles = readWakeEnvelopeFiles(localRoot);
    let woken = 0;
    const now = Date.now();
    for (const { path: envelopePath, env } of envelopeFiles) {
      const parsed = parseWakeRequestEnvelope(env);
      if (!parsed) continue;
      const { target, reason } = parsed;
      // Idempotence: skip if we already woke this target within 60s (belt).
      const lastWake = readWakeStampMs(localRoot, target);
      if (lastWake !== undefined && now - lastWake < WAKE_REQUEST_IDEMPOTENCE_MS) {
        process.stderr.write(
          `[remote] wake-request: skipping ${target} (already woken ${Math.round((now - lastWake) / 1000)}s ago)\n`,
        );
        continue;
      }
      const pane = resolveAgentPaneForInstance(target);
      if (!pane) {
        process.stderr.write(
          `[remote] wake-request: no agent pane for ${target} — not launched by remote, skipping (reason: ${reason || "none"})\n`,
        );
        continue;
      }
      // Guard (h2a 0.74.0 parity): defer send-keys if a human was active in the
      // pane's tmux session within the last 4s (client_activity, agnostic to TUI).
      // Fail-open: any probe failure (no clients, detached, error) proceeds normally.
      // The envelope is NOT marked .processed on defer — the watcher retries next tick.
      {
        const displayRes = spawnSync(
          "tmux",
          ["display-message", "-p", "-t", pane, "#{session_name}"],
          { encoding: "utf8" },
        );
        if (displayRes.status === 0 && displayRes.stdout?.trim()) {
          const sessionName = displayRes.stdout.trim();
          const clientsRes = spawnSync(
            "tmux",
            ["list-clients", `-t=${sessionName}`, "-F", "#{client_activity}"],
            { encoding: "utf8" },
          );
          if (clientsRes.status === 0 && clientsRes.stdout?.trim()) {
            const maxActivity = Math.max(
              ...clientsRes.stdout
                .trim()
                .split("\n")
                .map((s) => Number.parseInt(s.trim(), 10) * 1000)
                .filter((n) => !Number.isNaN(n)),
            );
            if (maxActivity > now - 4000) {
              process.stderr.write(
                `[remote] wake-request: deferring ${target} — human active ${Math.round((now - maxActivity) / 1000)}s ago, retrying next pass\n`,
              );
              continue;
            }
          }
        }
      }
      // F1: send a real instruction line via -l (literal, no shell expansion) then
      // Enter — Codex ignores empty send-keys submits; a real instruction forces a
      // read of the h2a inbox so the agent picks up the wake.
      // h2a 0.73.0 provides body.request.instructionLine — use it verbatim when
      // present. Fallback: compose the full command with --instance and --root so
      // `h2a inbox read` gets the required arguments (rc=1 without them).
      const instructionLine: string =
        (env as { body?: { request?: { instructionLine?: string } } }).body
          ?.request?.instructionLine ??
        `h2a inbox read --instance ${target} --root ${localRoot}`;
      spawnSync("tmux", ["send-keys", "-t", pane, "-l", instructionLine], {
        stdio: "ignore",
      });
      spawnSync("tmux", ["send-keys", "-t", pane, "Enter"], {
        stdio: "ignore",
      });
      // F2: mark envelope processed so it does not re-fire on future passes.
      markLaunchEnvelopeProcessed(envelopePath, `woke ${target}`);
      writeWakeStampMs(localRoot, target, now);
      woken += 1;
      process.stderr.write(
        `[remote] wake-request: woke ${target} → pane ${pane} (reason: ${reason || "none"})\n`,
      );
    }
    return woken;
  };

  program
    .command("wake-request")
    .description(
      "Handle an h2a `wake-request` envelope: read the local h2a inbox for a wake-request, " +
        "resolve the target agent pane from launch records, and send tmux send-keys to wake it. " +
        "No-op if no pane is known for the target (agent not launched by remote). " +
        "Idempotent: ignores duplicate wake-requests received within 60s. " +
        "--watch loops in the foreground.",
    )
    .option("--root <path>", "h2a root (default: ~/h2a-workspace/.h2a)")
    .option("--watch", "loop forever, polling every 30s")
    .option("--interval <seconds>", "poll interval in seconds (default: 30)", "30")
    .action(
      async (opts: { root?: string; watch?: boolean; interval?: string }) => {
        if (!tmuxAvailable()) {
          process.stderr.write("[remote] tmux is not installed locally\n");
          process.exitCode = 1;
          return;
        }
        const localRoot = opts.root ?? defaultLocalH2aRoot();
        const intervalMs =
          Math.max(1, Number.parseInt(opts.interval ?? "30", 10)) * 1000;
        if (!opts.watch) {
          const woken = wakeRequestPass(localRoot);
          process.stderr.write(
            `[remote] wake-request: ${woken} pane(s) woken this pass\n`,
          );
          return;
        }
        process.stderr.write(
          `[remote] wake-request watching (every ${Math.round(intervalMs / 1000)}s) — Ctrl-C to stop\n`,
        );
        let stopped = false;
        const onSigint = () => {
          stopped = true;
        };
        process.on("SIGINT", onSigint);
        try {
          while (!stopped) {
            const woken = wakeRequestPass(localRoot);
            process.stderr.write(
              `[remote] wake-request: ${woken} pane(s) woken — ${new Date().toISOString()}\n`,
            );
            if (stopped) break;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, intervalMs);
              if (stopped) {
                clearTimeout(timer);
                resolve();
              }
            });
          }
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
        process.stderr.write("[remote] wake-request watch stopped\n");
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
    .option(
      "--apply",
      "actually relaunch (default: dry-run, just print the plan)",
    )
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
  // Reliability slice 2 (throttle phase 2) — auto-resume RATE-LIMITED INTERACTIVE
  // local tmux sessions, staggered + hands-off.
  //
  // INTERACTIVE `remote run` sessions (claude/codex/agy in a live pane) do NOT
  // exit on a transient provider rate-limit — they STALL until a human pokes them.
  // This passes the pure `planInteractiveResume` the per-session pane tail
  // (detectThrottle source), `#{session_attached}` (the HARD detached-only guard),
  // and a stall verdict (idle shell OR an unchanged tail since the previous pass),
  // and nudges ONLY detached + stalled + due + under-cap sessions with a minimal
  // "continue" send-keys — at most the AIMD cap per pass, oldest-throttle first.
  //
  // SAFETY: we NEVER send keys into an attached pane (a human is there). DEFAULT
  // DRY-RUN — it just prints what it WOULD resume; `--apply` (or `--watch`) is the
  // opt-in that actually nudges.
  // ---------------------------------------------------------------------------

  /** Interactive (claude/codex/agy) local-tmux sessions, optional slug filter. */
  const listInteractiveThrottleSessions = (
    filter: string | undefined,
  ): Array<{ session: InteractiveSession; slug: string }> => {
    const enrolledAtBySlug = new Map<string, string>();
    for (const e of loadRegistry()) {
      if (e.kind === "local-tmux") enrolledAtBySlug.set(e.id, e.enrolledAt);
    }
    const out: Array<{ session: InteractiveSession; slug: string }> = [];
    for (const s of listLocalSessions()) {
      if (filter && !s.slug.includes(filter)) continue;
      const tool = coerceRegistryTool(s.profile);
      if (!tool) continue; // shell/opencode/… aren't agent CLIs with a throttle shape
      out.push({
        slug: s.slug,
        session: {
          name: s.name,
          type: tool,
          startedAt: enrolledAtBySlug.get(s.slug) ?? Date.now(),
        },
      });
    }
    return out;
  };

  /** Re-read `#{session_attached}` and return true ONLY when it is exactly 0. */
  const isDetachedNow = (name: string): boolean =>
    sessionAttachedCount(name) === 0;

  /**
   * One supervision pass over interactive sessions. The `throttleState` and
   * `prevTailHash` maps are owned by the caller so a `--watch` loop carries the
   * backoff bookkeeping + the prior tails (for the unchanged-tail stall signal)
   * across passes. `apply` gates the actual send-keys nudge. Returns the plan
   * (caller prints) plus the count actually nudged.
   */
  const interactiveResumePass = (
    filter: string | undefined,
    cap: number,
    apply: boolean,
    throttleState: Map<string, InteractiveThrottleInfo>,
    prevTailHash: Map<string, string>,
  ): { plan: InteractiveResumePlan; nudged: number } => {
    const found = listInteractiveThrottleSessions(filter);
    const sessions = found.map((f) => f.session);
    const attachedMap: Record<string, number | undefined> = {};
    const paneTails: Record<string, string | undefined> = {};
    const stalledMap: Record<string, boolean | undefined> = {};
    const liveNames = new Set<string>();
    for (const { session } of found) {
      liveNames.add(session.name);
      attachedMap[session.name] = sessionAttachedCount(session.name);
      const tail = capturePane(session.name, THROTTLE_TAIL_LINES);
      paneTails[session.name] = tail;
      // Stall corroboration: an idle shell (CLI dropped to the wrapper's bash) is
      // definitely stalled; otherwise compare the tail to the previous pass — an
      // UNCHANGED tail (and we saw it before) means the agent isn't producing
      // output, i.e. it is stuck on the rate-limit. A first sighting (no prior
      // hash) is NOT corroborated (conservative: wait one pass before nudging).
      const idle = localSessionIdle(session.name);
      const prev = prevTailHash.get(session.name);
      stalledMap[session.name] = idle || (prev !== undefined && prev === tail);
      prevTailHash.set(session.name, tail);
    }
    // Drop bookkeeping for sessions that are gone (don't leak across a fleet's life).
    for (const key of [...throttleState.keys()])
      if (!liveNames.has(key)) throttleState.delete(key);
    for (const key of [...prevTailHash.keys()])
      if (!liveNames.has(key)) prevTailHash.delete(key);

    const throttleStateObj: Record<
      string,
      InteractiveThrottleInfo | undefined
    > = {};
    for (const [k, v] of throttleState) throttleStateObj[k] = v;

    const plan = planInteractiveResume({
      sessions,
      now: Date.now(),
      throttleState: throttleStateObj,
      attachedMap,
      paneTails,
      stalledMap,
      cap,
    });

    let nudged = 0;
    if (apply) {
      for (const r of plan.toResume) {
        // DOUBLE-CHECK the attached guard at the moment of action (the pure plan
        // already excluded attached panes, but re-read in case a human just
        // attached between capture and nudge — belt and braces on a live pane).
        if (!isDetachedNow(r.name)) {
          process.stderr.write(
            `[remote] ${r.name} (${r.type}) just got attached — skipping the nudge\n`,
          );
          continue;
        }
        const ok = relaunchInSession(r.name, interactiveResumeNudge(r.type));
        if (ok) {
          nudged += 1;
          throttleState.set(r.name, r.next);
          process.stderr.write(
            `[remote] nudged ${r.name} (${r.type}) — continue (attempt ${r.next.attempts})\n`,
          );
        } else {
          process.stderr.write(`[remote] FAILED to nudge ${r.name}\n`);
        }
      }
    }
    return { plan, nudged };
  };

  program
    .command("resume-throttled [filter]")
    .description(
      "Auto-resume RATE-LIMITED INTERACTIVE local tmux sessions (claude/codex/agy). Detects the provider's transient rate-limit in each pane, and nudges ONLY a DETACHED, stalled session back to life (a minimal `continue`) — staggered (AIMD cap, oldest-first, backoff). NEVER touches a pane a human is attached to. DRY-RUN by default; --apply to actually nudge, or --watch to loop. [filter] = only sessions whose slug contains it.",
    )
    .option(
      "--apply",
      "actually send the resume nudge (default: dry-run, just print what it WOULD do)",
    )
    .option(
      "--watch <minutes>",
      "loop in the FOREGROUND every <minutes> (implies --apply); Ctrl-C to stop. Run it in a dedicated tmux window",
    )
    .option(
      "--max-concurrent <n>",
      "AIMD cap: max sessions nudged per pass (default: config maxConcurrent / REMOTE_MAX_CONCURRENT / 16)",
    )
    .action(
      async (
        filter: string | undefined,
        opts: { apply?: boolean; watch?: string; maxConcurrent?: string },
      ) => {
        if (!tmuxAvailable()) {
          process.stderr.write("[remote] tmux is not installed locally\n");
          process.exitCode = 1;
          return;
        }
        const capRaw =
          opts.maxConcurrent !== undefined
            ? Number.parseInt(opts.maxConcurrent, 10)
            : (getMaxConcurrent() ?? DEFAULT_MAX_CONCURRENT);
        const cap =
          Number.isFinite(capRaw) && capRaw > 0
            ? capRaw
            : DEFAULT_MAX_CONCURRENT;
        const minutes =
          opts.watch === undefined ? undefined : parseWatchMinutes(opts.watch);
        // --watch implies --apply (a dry-run loop would be pointless).
        const apply = opts.apply === true || minutes !== undefined;
        const throttleState = new Map<string, InteractiveThrottleInfo>();
        const prevTailHash = new Map<string, string>();

        const runOnce = () => {
          const { plan, nudged } = interactiveResumePass(
            filter,
            cap,
            apply,
            throttleState,
            prevTailHash,
          );
          for (const line of plan.advisories) process.stderr.write(`${line}\n`);
          if (!apply) {
            process.stderr.write(
              `[remote] DRY-RUN — would resume ${plan.toResume.length} session(s) ` +
                `(${plan.throttled.length} throttled, cap ${cap}). Pass --apply to nudge them.\n`,
            );
          } else {
            process.stderr.write(
              `[remote] resume-throttled: nudged ${nudged}/${plan.toResume.length} ` +
                `(${plan.throttled.length} throttled, cap ${cap})\n`,
            );
          }
          return { failed: 0 };
        };

        if (minutes === undefined) {
          runOnce();
          return;
        }
        process.stderr.write(
          `[remote] resume-throttled watching (cap ${cap}, every ${minutes} min) — Ctrl-C to stop\n`,
        );
        process.exitCode = await watchRefreshLoop(minutes, async () =>
          runOnce(),
        );
      },
    );

  // ---------------------------------------------------------------------------
  // h2a — bridge the local agent network (~/h2a-workspace/.h2a) with session Pods
  // ---------------------------------------------------------------------------

  const h2aCommand = program
    .command("h2a")
    .description(
      "h2a agent-network helpers (local file store: ~/h2a-workspace/.h2a)",
    );
  h2aCommand
    .command("ping <instance>")
    .description(
      "Drop an `h2a.ping` envelope into the local h2a inbox for <instance> (e.g. codex:remote:sess-1). Use --bridge to push it to a remote session immediately.",
    )
    .option("--from <instance>", "sender h2a instance", "remote:cli")
    .option("-m, --message <text>", "ping message body", "ping")
    .option("--root <path>", "local h2a root (default: ~/h2a-workspace/.h2a)")
    .option(
      "--bridge [sessionId]",
      "after queuing the ping, run one h2a bridge pass for this remote session (defaults from <instance> when it is <tool>:remote:<sessionId>)",
    )
    .action(
      async (
        instance: string,
        opts: {
          from?: string;
          message?: string;
          root?: string;
          bridge?: string | boolean;
        },
      ) => {
        const ping = sendH2aPing({
          to: instance,
          ...(opts.from !== undefined ? { from: opts.from } : {}),
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          cwd: process.cwd(),
          ...(opts.root !== undefined ? { localRoot: opts.root } : {}),
        });
        process.stderr.write(
          `[remote] h2a ping ${ping.written ? "queued" : "already queued"} for ${instance}: ${ping.path}\n`,
        );
        if (opts.bridge === undefined) return;

        const sessionId =
          typeof opts.bridge === "string"
            ? opts.bridge
            : remoteSessionIdFromInstance(instance);
        if (!sessionId) {
          process.stderr.write(
            "[remote] --bridge needs a session id, or an instance shaped like <tool>:remote:<sessionId>\n",
          );
          process.exitCode = 1;
          return;
        }
        const url = getConfiguredRemote();
        await ensureConnected(url);
        const profile = (await getRemoteSession(url, sessionId)).session
          .profile;
        const { bridgeSession } = await import("./h2a-bridge.js");
        try {
          const r = await bridgeSession(sessionId, { profile });
          process.stderr.write(
            `[remote] h2a bridge ${sessionId} (${profile}) pulled=${r.pulled} pushed=${r.pushed} skipped=${r.skipped}` +
              `${r.failed > 0 ? ` failed=${r.failed}` : ""}\n`,
          );
          if (r.failed > 0) process.exitCode = 1;
        } catch (error) {
          process.stderr.write(
            `[remote] h2a bridge ${sessionId} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`,
          );
          process.exitCode = 1;
        }
      },
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
        const bridgeTunnel = getTunnel();
        for (const s of sessions) {
          // DEAD-POD GUARD: a non-Running (Evicted/OOM/completed) Pod can't be
          // exec'd — skip it with a single advisory instead of a per-pass
          // `cannot exec into a completed pod` error. Running Pods bridge as before.
          if (bridgeTunnel) {
            const liveness = checkPodLiveness(bridgeTunnel, `session-${s.id}`);
            if (!liveness.executable) {
              process.stderr.write(
                `${deadPodAdvisory(s.id, liveness.phase)}\n`,
              );
              continue;
            }
          }
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
      'Relance les sessions dev dans leur layout (fenêtre par groupe, onglet par session). Sans argument: tous les groupes. Avec [group]: ce lot seulement (ex: `remote restore "full remote"`). Groupes LOCAUX = claude/codex sous ~/src/* (tmux via `remote run`); groupes REMOTE = sessions SCW (`remote attach <id> --exec`). Layout: champ `layout` de la config.',
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
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
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
    .option(
      "--cwd <dir>",
      "manual mode: session working directory (default: cwd)",
    )
    .option(
      "--conv <id>",
      "manual mode: conversation id (used by restore --resume)",
    )
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
            process.stderr.write(
              `[remote] enroll hook ignored: ${String(error)}\n`,
            );
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
    .description(
      "Layout auto-enregistré par `remote restore` (layout-last.json)",
    );

  layoutCommand
    .command("show")
    .description(
      "Affiche le dernier layout lancé (fenêtres, onglets, commandes)",
    )
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
    .option(
      "--name <name>",
      "set the session's display name (shown as PROJECT in `remote ls`); applied on the hard refresh (Pod recreate), ignored with --soft",
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
            // Slice 2: record the cadence so `ls`/`jobs ls` can judge heartbeat
            // staleness (older than 2× interval ⇒ the watcher likely stopped).
            writeSupervisorIntervalMs(watchMinutes * 60_000);
            // Re-ensure the tunnel EACH pass: after a control-plane redeploy
            // (or laptop sleep) the port-forward dies and every pass would
            // otherwise fail with "fetch failed". ensureConnected is idempotent
            // and rebuilds a stale-but-alive tunnel.
            process.exitCode = await watchRefreshLoop(
              watchMinutes,
              async () => {
                await ensureConnected(url);
                return softRefreshAllSessions(url, opts, hashes);
              },
            );
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
          writeSupervisorIntervalMs(watchMinutes * 60_000);
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
            opts.profile ??
            (await getRemoteSession(url, sessionId)).session.profile;
          const resolved = coerceCliProfileName(profile);
          if (!resolved) throw new Error(`Unknown profile "${profile}"`);
          if (opts.authRefresh !== false) {
            const fresh = await ensureProfileAuthFresh(resolved);
            if (fresh.checked)
              process.stderr.write(
                `[remote] auth status ok: ${fresh.command}\n`,
              );
          }
          await softRefreshSession(sessionId, resolved);
          return;
        }
        await ensureConnected(url);
        await refreshProfileSession(url, sessionId, opts);
      },
    );

  program
    .command("ls [url]")
    .description(
      "List sessions — LOCAL (tmux) and REMOTE (control-plane) — uniformly",
    )
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
          const label = s.displayName ?? s.slug;
          process.stdout.write(
            `  ${w(label, 20)} ${w(s.profile, 7)} ${w(s.state, 9)} ${w(`[${s.badge}]`, 10)} ${s.path}\n`,
          );
        }
      }

      if (opts.local) {
        if (local.length === 0)
          process.stderr.write("[remote] no local sessions\n");
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
      // Slice 2 — creds reliability advisories: warn (detection only) when the
      // creds supervisor isn't running / its heartbeat is stale, or the local
      // claude OAuth token is expiring. These Pods are exactly what drifts to 401.
      const supWarn = supervisorStalenessAdvisory();
      if (supWarn) process.stderr.write(`${supWarn}\n`);
      const claudeWarn = localClaudeExpiryAdvisory();
      if (claudeWarn) process.stderr.write(`${claudeWarn}\n`);
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

  program
    .command("rename <slugOrId> <newName>")
    .description(
      "Rename a session's display name without restarting the Pod. Also renames the local tmux window if a matching local session exists.",
    )
    .option("--remote <url>", "override the configured remote URL")
    .action(
      async (slugOrId: string, newName: string, opts: { remote?: string }) => {
        // Store display name on the local tmux session (without rename-window,
        // which would disable allow-rename per-window and break the live
        // activity-status title forwarded via pane_title / OSC sequence).
        const local = findLocalSession(slugOrId);
        if (local) {
          setLocalSessionDisplayName(local.name, newName);
          process.stderr.write(
            `[remote] local session display name set to "${newName}"\n`,
          );
        }
        // Rename on the control-plane.
        const url = getConfiguredRemote(opts.remote);
        await ensureConnected(url);
        // If we found a local session, try to use its session id from the
        // remote listing; otherwise treat slugOrId as a sessionId directly.
        let sessionId = slugOrId;
        if (local) {
          try {
            const sessions = await listRemoteSessions(url);
            const match = sessions.find(
              (s) =>
                s.id === local.slug ||
                s.displayName === local.slug ||
                s.id === slugOrId,
            );
            if (match) sessionId = match.id;
          } catch {
            // best-effort — fall back to slugOrId as sessionId
          }
        }
        const result = await renameRemoteSession(url, sessionId, newName);
        process.stderr.write(
          `[remote] session ${result.sessionId} renamed to "${result.displayName}" (accepted: ${String(result.accepted)})\n`,
        );
      },
    );

  // ---------------------------------------------------------------------------
  // account — WP16 Layer-C: local LLM account pool (enroll / ls / rm / select)
  // ---------------------------------------------------------------------------

  const accountCommand = program
    .command("account")
    .description("Manage the local LLM account pool (WP16)");

  accountCommand
    .command("enroll")
    .description(
      "Register an LLM account. Pass the access token via REMOTE_ACCOUNT_TOKEN " +
        "env var (never as a flag — that leaks to shell history), OR use " +
        "--from-credentials to read from the CLI's own config file. " +
        "Descriptor written to ~/.sentropic/accounts.json (0600); " +
        "token written to ~/.sentropic/accounts-tokens.json (0600).",
    )
    .requiredOption(
      "--provider <provider>",
      "LLM provider: claude-code | codex",
    )
    .requiredOption("--label <label>", "Human-readable account label")
    .option(
      "--id <id>",
      "Unique account id (default: <provider>-<epoch>)",
    )
    .option(
      "--from-credentials",
      "Read access token from the CLI's local config file (~/.claude/.credentials.json " +
        "for claude-code, ~/.codex/auth.json for codex) instead of REMOTE_ACCOUNT_TOKEN.",
    )
    .option(
      "--config-dir <path>",
      "Custom config directory to read credentials from (used with --from-credentials).",
    )
    .action(
      (opts: { provider: string; label: string; id?: string; fromCredentials?: boolean; configDir?: string }) => {
        const provider = opts.provider as AccountProvider;
        if (provider !== "claude-code" && provider !== "codex") {
          process.stderr.write(
            `[remote] account enroll: unknown provider "${opts.provider}" (known: claude-code, codex)\n`,
          );
          process.exitCode = 1;
          return;
        }
        let accessToken: string;
        if (opts.fromCredentials) {
          const result =
            provider === "claude-code"
              ? readClaudeCredential(opts.configDir)
              : readCodexCredential(opts.configDir);
          if (!result.ok) {
            process.stderr.write(`[remote] account enroll: ${result.error}\n`);
            process.exitCode = 1;
            return;
          }
          accessToken = result.accessToken;
          process.stderr.write(
            `[remote] account enroll: read token from ${provider === "claude-code" ? "~/.claude/.credentials.json" : "~/.codex/auth.json"}\n`,
          );
        } else {
          accessToken = process.env.REMOTE_ACCOUNT_TOKEN ?? "";
          if (!accessToken.trim()) {
            process.stderr.write(
              "[remote] account enroll: REMOTE_ACCOUNT_TOKEN env var is not set or empty\n" +
                "[remote] (tip: use --from-credentials to read from the CLI's local config)\n",
            );
            process.exitCode = 1;
            return;
          }
        }
        const result = enrollAccount({
          provider,
          label: opts.label,
          accessToken,
          ...(opts.id !== undefined ? { id: opts.id } : {}),
          // For claude-code: store configDir so startJob can inject CLAUDE_CONFIG_DIR.
          ...(provider === "claude-code" && opts.configDir !== undefined
            ? { configDir: opts.configDir }
            : {}),
        });
        if (!result.ok) {
          process.stderr.write(`[remote] account enroll: ${result.error}\n`);
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          `[remote] account enrolled: ${result.descriptor.id} (${result.descriptor.provider}) "${result.descriptor.label}"\n`,
        );
      },
    );

  accountCommand
    .command("ls")
    .description(
      "List enrolled LLM accounts with quota/exhaustion status (descriptors only — no tokens).",
    )
    .option("--json", "Output as JSON array")
    .action((opts: { json?: boolean }) => {
      const accounts = listAccountsWithStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(accounts, null, 2) + "\n");
        return;
      }
      if (accounts.length === 0) {
        process.stderr.write("[remote] no accounts enrolled\n");
        return;
      }
      const hasConfigDir = accounts.some((a) => a.configDir !== undefined);
      const header = ["ID", "PROVIDER", "LABEL", "QUOTA", "ENROLLED"]
        .concat(hasConfigDir ? ["CONFIG-DIR"] : []);
      const rows = accounts.map((a) => {
        const quota = a.exhausted
          ? `QUOTA_EXCEEDED (resets ${(a.quotaResetsAt ?? "?").slice(0, 19)})`
          : "ok";
        return [a.id, a.provider, a.label, quota, a.enrolledAt.slice(0, 19)]
          .concat(hasConfigDir ? [a.configDir ?? ""] : []);
      });
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => r[i]!.length)),
      );
      const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
      process.stdout.write([line(header), ...rows.map(line)].join("\n") + "\n");
    });

  accountCommand
    .command("rm <id>")
    .description("Remove an enrolled account (descriptor + token).")
    .action((id: string) => {
      const result = removeAccount(id);
      if (!result.ok) {
        process.stderr.write(`[remote] account rm: ${result.error}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`[remote] account removed: ${result.id}\n`);
    });

  accountCommand
    .command("exhausted <id>")
    .description(
      "Mark an account as quota-exhausted for a given window (default 5h). " +
        "New sessions skip exhausted accounts; selectAccountWithFallback() " +
        "tries the next same-provider account then falls back cross-provider.",
    )
    .option(
      "--window <window>",
      'Exhaustion window: "5h" (default), "week" (7d), or a raw number of hours.',
      "5h",
    )
    .option("--reason <reason>", "Optional reason label (e.g. \"429 rate-limit\")")
    .action((id: string, opts: { window?: string; reason?: string }) => {
      const windowMs = (() => {
        if (!opts.window || opts.window === "5h") return QUOTA_WINDOW_5H_MS;
        if (opts.window === "week") return QUOTA_WINDOW_WEEK_MS;
        const h = Number(opts.window.replace(/h$/i, ""));
        return Number.isFinite(h) && h > 0 ? h * 60 * 60 * 1_000 : QUOTA_WINDOW_5H_MS;
      })();
      const rec = markExhausted(id, windowMs, opts.reason);
      const resetsAt = new Date(new Date(rec.exhaustedAt).getTime() + windowMs).toISOString();
      process.stderr.write(
        `[remote] account ${id} marked exhausted — resets at ${resetsAt}` +
          (opts.reason ? ` (reason: ${opts.reason})` : "") +
          "\n",
      );
    });

  accountCommand
    .command("clear-quota <id>")
    .description(
      "Clear the quota exhaustion for an account (manual override — the account " +
        "becomes immediately available for selection again).",
    )
    .action((id: string) => {
      clearExhaustion(id);
      process.stderr.write(`[remote] account ${id} quota cleared — available for selection\n`);
    });

  accountCommand
    .command("select")
    .description(
      "Dry-run: show which account selectAccount() would pick for a new session " +
        "(round-robin, no I/O, stub planner).",
    )
    .option("--provider <provider>", "Filter by provider (required with --fallback)")
    .option("--last-used <id>", "Pretend this account was used last (simple round-robin only)")
    .option(
      "--fallback",
      "Use selectAccountWithFallback() — quota-aware, cross-provider fallback — instead of plain round-robin. Requires --provider.",
    )
    .option("--affinity-key <key>", "Sticky-binding key to test (used with --fallback, e.g. a job id)")
    .action((opts: { provider?: string; lastUsed?: string; fallback?: boolean; affinityKey?: string }) => {
      if (opts.fallback) {
        if (!opts.provider || (opts.provider !== "claude-code" && opts.provider !== "codex")) {
          process.stderr.write("[remote] account select --fallback requires --provider claude-code|codex\n");
          process.exitCode = 1;
          return;
        }
        const provider = opts.provider as AccountProvider;
        const sel = selectAccountWithFallback(provider, opts.affinityKey);
        if (!sel.candidate) {
          process.stderr.write("[remote] account select: all accounts exhausted — no usable account available\n");
          process.exitCode = 1;
          return;
        }
        const { accessToken: _t, ...desc } = sel.candidate;
        const crossProvider = "crossProvider" in sel ? sel.crossProvider : false;
        const originalProvider = "originalProvider" in sel ? sel.originalProvider : undefined;
        process.stdout.write(
          JSON.stringify({
            selected: desc,
            crossProvider,
            ...(originalProvider !== undefined ? { originalProvider } : {}),
          }, null, 2) + "\n",
        );
        return;
      }
      const provider = opts.provider as AccountProvider | undefined;
      const candidates = loadCandidates(provider).map(({ accessToken: _t, ...d }) => d);
      const pick = selectAccount(candidates, opts.lastUsed);
      if (!pick) {
        process.stderr.write("[remote] account select: no candidates available\n");
        return;
      }
      process.stdout.write(
        JSON.stringify({ selected: pick, totalCandidates: candidates.length }, null, 2) + "\n",
      );
    });

  accountCommand
    .command("log")
    .description(
      "Show the local account selection log (~/.sentropic/session-log.jsonl). " +
        "Each line records which account was used per job launch, including cross-provider fallbacks.",
    )
    .option("-n, --last <n>", "Show last N entries (default: 20)")
    .option("--json", "Output raw JSONL")
    .action((opts: { last?: string; json?: boolean }) => {
      const logFile = sessionLogPath();
      let raw: string;
      try {
        raw = readFileSync(logFile, "utf8");
      } catch {
        process.stderr.write("[remote] account log: no session log yet (no jobs launched with accounts enrolled)\n");
        return;
      }
      const lines = raw.split("\n").filter(Boolean);
      const n = opts.last !== undefined ? Number.parseInt(opts.last, 10) : 20;
      const tail = Number.isFinite(n) && n > 0 ? lines.slice(-n) : lines;
      if (opts.json) {
        process.stdout.write(tail.join("\n") + "\n");
        return;
      }
      if (tail.length === 0) {
        process.stderr.write("[remote] account log: empty\n");
        return;
      }
      process.stdout.write(
        ["AT                       JOB-ID           PREFERRED        SELECTED         ACCOUNT-LABEL   CROSS"]
          .concat(
            tail.map((line) => {
              try {
                const e = JSON.parse(line) as { at: string; jobId: string; preferredProvider: string; selectedProvider: string; accountLabel: string; crossProvider: boolean };
                const cross = e.crossProvider ? " ⚠" : "";
                return [
                  (e.at ?? "").slice(0, 23).padEnd(24),
                  (e.jobId ?? "").slice(0, 16).padEnd(17),
                  (e.preferredProvider ?? "").padEnd(16),
                  (e.selectedProvider ?? "").padEnd(16),
                  (e.accountLabel ?? "").slice(0, 15).padEnd(16),
                  cross,
                ].join(" ").trimEnd();
              } catch {
                return line;
              }
            }),
          )
          .join("\n") + "\n",
      );
    });

  // ---------------------------------------------------------------------------
  // lineage — local incarnation lifecycle (Phase A0c)
  // ---------------------------------------------------------------------------

  const lineageCommand = program
    .command("lineage")
    .description("Manage local lineage incarnation lifecycle");

  lineageCommand
    .command("suspend <id>")
    .description(
      "Suspend the local incarnation for a lineage: writes a sentinel file that prevents the agent from starting a new turn. Does NOT kill the process.",
    )
    .action((id: string) => {
      suspendLocalIncarnation(id as LineageId);
      process.stderr.write(`[remote] lineage ${id} suspended\n`);
    });

  lineageCommand
    .command("resume <id>")
    .description(
      "Resume a previously suspended local incarnation: removes the sentinel file.",
    )
    .action((id: string) => {
      const wasSuspended = isIncarnationSuspended(id as LineageId);
      resumeLocalIncarnation(id as LineageId);
      process.stderr.write(
        wasSuspended
          ? `[remote] lineage ${id} resumed\n`
          : `[remote] lineage ${id} was not suspended (no-op)\n`,
      );
    });

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
