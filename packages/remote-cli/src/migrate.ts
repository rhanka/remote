/**
 * remote migrate — convenience wrapper for round-tripping a local CLI session
 * to a remote (SCW k8s) session and back.
 *
 * Forward (local → remote):
 *   1. Resolve remote URL.
 *   2. Ensure the cwd is linked to a workspace (reads .remote/workspace.json).
 *   3. Push the workspace archive (project files, honours .gitignore).
 *   4. Create a remote session for <profile> bound to that workspace.
 *   5. Hand off the current terminal to the remote session via `attach`.
 *      The attach call blocks until the session ends or the user detaches
 *      (Ctrl+P Ctrl+Q). There is no separate process to kill — `migrate`
 *      itself IS the process holding the terminal, and attach takes it over.
 *
 * Back (remote → local):
 *   1. Resolve URL + workspace.
 *   2. Pull the workspace + conversation state (3-way merge).
 *   3. Restore conversation state to the local HOME.
 *   4. Stop the remote session.
 *   5. Print the exact local CLI command to resume from the restored state.
 *      We do NOT spawn the CLI — we print the command so the user can run it.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { attach, createRemoteSession, stopRemoteSession } from "./attach.js";
import { coerceCliProfileName, resolveProfile } from "./profiles.js";
import { collectProfileAuth } from "./auth-bundle.js";
import { collectToolAuth } from "./auth-tools.js";
import {
  acquireWorkspaceLock,
  createWorkspace,
  downloadWorkspaceExport,
  lockHolderId,
  readBaseSnapshot,
  readWorkspaceMarker,
  releaseWorkspaceLock,
  writeBaseSnapshot,
  writeWorkspaceMarker,
  type WorkspaceMarker,
} from "./workspace.js";
import {
  buildWorkspaceArchive,
  uploadWorkspaceArchive,
} from "./workspace-sync.js";
import { mergeWorkspaceArchive } from "./workspace-merge.js";
import { restoreSessionsToLocal, type OnConflict } from "./session-restore.js";

import { CLI_PROFILES } from "@sentropic/remote-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrateForwardOptions = {
  /** CLI profile to start on the remote (e.g. "claude", "codex"). */
  readonly profile: string;
  /** Remote control-plane URL. Required — callers must resolve the default. */
  readonly remoteUrl: string;
  /**
   * Workspace id override. When set, the cwd does not need an existing
   * .remote/workspace.json (one is created/reused for that id).
   * When absent, the .remote/workspace.json for the cwd is used or a new
   * workspace is created and linked.
   */
  readonly workspaceId?: string;
  /**
   * Whether to pass a --resume/<conv-id> flag to the remote CLI.
   * Pass `true` for the most-recent conversation, or a specific id string.
   */
  readonly resume?: string | true;
  /**
   * When true, do NOT hijack the current terminal: push + create the remote
   * session, print the `remote attach` command, and return. Used to migrate
   * many sessions non-interactively and to let YOUR terminal reconnect to the
   * remote session itself (rather than this process taking it over).
   */
  readonly noAttach?: boolean;
  /**
   * Revive a session on the EXISTING workspace without re-pushing the project
   * (preserves work done remotely) — for bringing a session back after an
   * accidental exit. Path/HOME parity + resume still apply; the conversation is
   * the one already on the retained PVC.
   */
  readonly reconnect?: boolean;
  /** Tool CLIs whose local auth to also bundle into the Pod (scw, gh, aws, …). */
  readonly tools?: ReadonlyArray<string>;
  /** Inject a custom fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Override process.cwd() for tests. */
  readonly cwd?: string;
  /** Override process.stderr.write for tests. */
  readonly stderr?: NodeJS.WriteStream;
};

export type MigrateForwardResult = {
  /** The workspace id that was used/created. */
  readonly workspaceId: string;
  /** The remote session id that was created. */
  readonly sessionId: string;
};

export type MigrateBackOptions = {
  /** Remote control-plane URL. Required — callers must resolve the default. */
  readonly remoteUrl: string;
  /** Workspace id override; falls back to .remote/workspace.json. */
  readonly workspaceId?: string;
  /**
   * Conflict resolution for diverged conversations: "backup" | "keep-local".
   * Defaults to "block" (leaves diverged files untouched, exits non-zero).
   */
  readonly onConflict?: OnConflict;
  /** Inject a custom fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Override process.cwd() for tests. */
  readonly cwd?: string;
  /** Override HOME for session restore in tests. */
  readonly home?: string;
  /** Override process.stderr.write for tests. */
  readonly stderr?: NodeJS.WriteStream;
  /** Override process.stdout.write for tests. */
  readonly stdout?: NodeJS.WriteStream;
};

export type MigrateBackResult = {
  /** The workspace id that was pulled. */
  readonly workspaceId: string;
  /** The session id that was stopped, if any. */
  readonly stoppedSessionId?: string;
  /** The resume command to print for the user. */
  readonly resumeCommand: string;
  /** Whether there were unresolved merge conflicts. */
  readonly hasConflicts: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve (or create + link) a workspace for the given cwd.
 * Priority: explicit workspaceId arg > .remote/workspace.json > create new.
 */
async function resolveOrCreateWorkspace(
  cwd: string,
  remoteUrl: string,
  workspaceIdOverride: string | undefined,
  fetchImpl: typeof fetch,
  stderr: NodeJS.WriteStream,
): Promise<WorkspaceMarker> {
  if (workspaceIdOverride) {
    // Honour the override; persist a marker if one doesn't already exist.
    const existing = readWorkspaceMarker(cwd);
    if (existing && existing.workspaceId === workspaceIdOverride) {
      return existing;
    }
    const marker: WorkspaceMarker = {
      remote: remoteUrl,
      workspaceId: workspaceIdOverride,
    };
    writeWorkspaceMarker(cwd, marker);
    stderr.write(
      `[remote] using workspace ${workspaceIdOverride} (from --workspace flag)\n`,
    );
    return marker;
  }

  const existing = readWorkspaceMarker(cwd);
  if (existing) {
    stderr.write(
      `[remote] cwd mapped to ${existing.workspaceId} (reusing workspace)\n`,
    );
    return existing;
  }

  // Create and link a new workspace.
  const ws = await createWorkspace(remoteUrl, {}, fetchImpl);
  const marker: WorkspaceMarker = { remote: remoteUrl, workspaceId: ws.id };
  writeWorkspaceMarker(cwd, marker);
  stderr.write(
    `[remote] created workspace ${ws.id} and linked to ${cwd}\n`,
  );
  return marker;
}

/**
 * Build the resume startupArgs for a profile, given a session id (or true for
 * the most-recent session).
 */
function buildResumeStartupArgs(
  profileName: string,
  resume: string | true,
): string[] {
  const config = resolveProfile(profileName);
  if (!config.resumeFlag) return [];
  return resume === true ? [config.resumeFlag] : [config.resumeFlag, resume];
}

/**
 * Profile conversation dirs (HOME-relative), mirrored from the session-agent's
 * restore mapping (`<workspace>/.remote/sessions/<profile>/<relDir>` →
 * `<home>/<relDir>`).
 */
const PROFILE_STATE_DIRS: Readonly<Record<string, string>> = {
  claude: ".claude/projects",
};

const STATE_SUBDIR = ".remote/sessions";

/**
 * Stage the live (most-recent) local conversation for `cwd` into the workspace
 * under `.remote/sessions/<profile>/<relDir>/<projectDir>` so it rides the
 * pushed archive and the session-agent restores it into the Pod's HOME — so the
 * remote CLI `--resume` picks up exactly where the local session left off.
 *
 * Uses claude's cwd→dir encoding (slashes → dashes). With path parity (the
 * Pod's cwd equals `cwd`) the remote CLI derives the identical project dir name,
 * so the staged conversation is found on resume. Returns the staged conversation
 * id (filename stem), or undefined if nothing was captured.
 */
/**
 * Most-recent local conversation id for `cwd` (the active session), or
 * undefined. Used to pass the exact id to the remote CLI's `--resume <id>` so it
 * resumes directly instead of showing the interactive picker.
 */
function newestLocalConvId(
  cwd: string,
  profile: string,
  home: string,
): string | undefined {
  const relDir = PROFILE_STATE_DIRS[profile];
  if (!relDir) return undefined;
  const src = join(home, relDir, cwd.replace(/\//g, "-"));
  if (!existsSync(src)) return undefined;
  let newest: { name: string; mtime: number } | undefined;
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      const m = statSync(join(src, e.name)).mtimeMs;
      if (!newest || m > newest.mtime) newest = { name: e.name, mtime: m };
    }
  }
  return newest?.name.replace(/\.jsonl$/, "");
}

function captureLiveConversation(
  cwd: string,
  profile: string,
  home: string,
  stderr: NodeJS.WriteStream,
): string | undefined {
  const relDir = PROFILE_STATE_DIRS[profile];
  if (!relDir) return undefined; // only claude's path-encoded projects for now
  const projectDir = cwd.replace(/\//g, "-");
  const src = join(home, relDir, projectDir);
  if (!existsSync(src)) return undefined;

  let newest: { name: string; mtime: number } | undefined;
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      const m = statSync(join(src, e.name)).mtimeMs;
      if (!newest || m > newest.mtime) newest = { name: e.name, mtime: m };
    }
  }
  if (!newest) return undefined;

  const dstDir = join(cwd, STATE_SUBDIR, profile, relDir, projectDir);
  rmSync(join(cwd, STATE_SUBDIR, profile), { recursive: true, force: true });
  mkdirSync(dstDir, { recursive: true });
  // Stage only the main conversation .jsonl — it holds the full conversation.
  // The companion `<convId>/` dir (subagent transcripts) is auxiliary, only used
  // to expand subagent detail, and can be huge; skip it to stay lean (the remote
  // archive has a size cap and rides a fragile port-forward).
  cpSync(join(src, newest.name), join(dstDir, newest.name));
  const convId = newest.name.replace(/\.jsonl$/, "");
  stderr.write(
    `[remote] captured live ${profile} conversation ${convId} for resume\n`,
  );
  return convId;
}

/**
 * Record the repo's origin/branch/HEAD into `<cwd>/.remote/git.json` so the
 * session-agent can bootstrap git in the Pod (clone-on-start) when the full
 * `.git` was too big to ship — the Pod fetches history from origin (gh auth is
 * bundled) instead of transferring it. No-op outside a git repo / without an
 * origin remote.
 */
function writeGitMetadata(cwd: string, stderr: NodeJS.WriteStream): void {
  const git = (args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const origin = git(["remote", "get-url", "origin"]);
  if (!origin) return;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "HEAD"]);
  try {
    mkdirSync(join(cwd, ".remote"), { recursive: true });
    writeFileSync(
      join(cwd, ".remote", "git.json"),
      JSON.stringify({ origin, branch, head }, null, 2),
      "utf8",
    );
    stderr.write(
      `[remote] recorded git origin for clone-on-start: ${origin} (${branch || "HEAD"})\n`,
    );
  } catch {
    // best-effort
  }
}

/**
 * Push workspace project files to the remote, reusing the same pattern as
 * `workspace push` in index.ts.
 */
async function pushWorkspace(
  cwd: string,
  remoteUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch,
  stderr: NodeJS.WriteStream,
): Promise<Buffer> {
  await acquireWorkspaceLock(remoteUrl, workspaceId, lockHolderId(), 300, fetchImpl);
  try {
    stderr.write(`[remote] packing ${cwd} (respecting .gitignore)\n`);
    const archive = await buildWorkspaceArchive(cwd);
    stderr.write(
      `[remote] archive: ${(archive.byteLength / 1024).toFixed(0)} KiB -> ${workspaceId}\n`,
    );
    // Use a throwaway shell session to seed the PVC.
    const session = await createRemoteSession(
      remoteUrl,
      {
        profile: "shell",
        workspaceId,
        workspaceSync: true,
        startupArgs: ["-c", "exit 0"],
      },
      fetchImpl,
    );
    await uploadWorkspaceArchive(remoteUrl, session.id, archive, fetchImpl);
    const attached = await attach({
      baseUrl: remoteUrl,
      sessionId: session.id,
      fetchImpl,
    });
    await attached.finished;
    writeBaseSnapshot(cwd, archive);
    stderr.write(`[remote] pushed ${cwd} to ${workspaceId}\n`);
    return archive;
  } finally {
    await releaseWorkspaceLock(remoteUrl, workspaceId, fetchImpl);
  }
}

/**
 * Pull workspace project files + session state from the remote, using the same
 * pattern as `workspace pull --restore-sessions` in index.ts.
 */
async function pullWorkspace(
  cwd: string,
  home: string,
  remoteUrl: string,
  workspaceId: string,
  onConflict: OnConflict,
  fetchImpl: typeof fetch,
  stderr: NodeJS.WriteStream,
): Promise<{ remoteArchive: Buffer | null; hasConflicts: boolean }> {
  await acquireWorkspaceLock(remoteUrl, workspaceId, lockHolderId(), 300, fetchImpl);
  try {
    const session = await createRemoteSession(
      remoteUrl,
      {
        profile: "shell",
        workspaceId,
        workspaceExport: true,
        startupArgs: ["-c", "sleep 120"],
      },
      fetchImpl,
    );
    let remoteArchive: Buffer | null = null;
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        remoteArchive = await downloadWorkspaceExport(
          remoteUrl,
          session.id,
          fetchImpl,
        );
        if (remoteArchive) break;
        await new Promise<void>((r) => setTimeout(r, 1000));
      }
    } finally {
      await stopRemoteSession(remoteUrl, session.id, "pull-complete", fetchImpl);
    }

    if (!remoteArchive) {
      stderr.write(
        `[remote] nothing to pull (workspace ${workspaceId} produced no export)\n`,
      );
      return { remoteArchive: null, hasConflicts: false };
    }

    const mergeResult = mergeWorkspaceArchive({
      cwd,
      remoteArchive,
      baseArchive: readBaseSnapshot(cwd),
    });
    stderr.write(
      `[remote] pull: ${mergeResult.tookRemote.length} from remote, ${mergeResult.keptLocal.length} kept local, ${mergeResult.merged.length} merged\n`,
    );

    let hasConflicts = false;
    if (mergeResult.conflicts.length > 0) {
      stderr.write(
        `[remote] ${mergeResult.conflicts.length} conflict(s) (left with markers, resolve then re-run):\n`,
      );
      for (const f of mergeResult.conflicts) stderr.write(`  ${f}\n`);
      hasConflicts = true;
    } else {
      writeBaseSnapshot(cwd, remoteArchive);
      stderr.write(`[remote] pulled ${workspaceId} into ${cwd}\n`);
    }

    // Restore conversation state.
    let anySessionConflict = false;
    for (const profile of CLI_PROFILES) {
      const r = restoreSessionsToLocal({
        home,
        profile,
        remoteArchive,
        onConflict,
      });
      const touched = r.restored.length + r.backedUp.length + r.conflicts.length;
      if (touched === 0 && r.keptLocal.length === 0) continue;
      stderr.write(
        `[remote] sessions(${profile}): ${r.restored.length} restored, ${r.backedUp.length} backed-up, ${r.keptLocal.length} kept, ${r.conflicts.length} conflict\n`,
      );
      for (const b of r.backedUp) stderr.write(`    backup ${b}\n`);
      if (r.conflicts.length > 0) {
        anySessionConflict = true;
        for (const c of r.conflicts) stderr.write(`    conflict ${c}\n`);
      }
    }
    if (anySessionConflict) {
      stderr.write(
        `[remote] diverged conversations left untouched. Re-run with --on-conflict backup or keep-local.\n`,
      );
      hasConflicts = true;
    }

    return { remoteArchive, hasConflicts };
  } finally {
    await releaseWorkspaceLock(remoteUrl, workspaceId, fetchImpl);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Forward: migrate the current local session to a remote k8s session.
 *
 * Steps: link workspace → push files → create remote session → attach terminal.
 *
 * Terminal handoff: `migrateForward` calls `attach`, which hijacks the current
 * process's stdin/stdout in raw mode and blocks until the remote session ends
 * or the user presses Ctrl+P Ctrl+Q to detach. There is no separate process
 * involved — this function IS the process holding the terminal.
 */
export async function migrateForward(
  options: MigrateForwardOptions,
): Promise<MigrateForwardResult> {
  const {
    profile: profileName,
    remoteUrl,
    resume,
    fetchImpl = fetch,
    cwd = process.cwd(),
    stderr = process.stderr,
  } = options;

  const profile = coerceCliProfileName(profileName);
  if (!profile) {
    throw new Error(
      `Unknown profile "${profileName}". Known: codex, claude, agy, opencode, shell`,
    );
  }

  // Step 1: ensure workspace is linked.
  const marker = await resolveOrCreateWorkspace(
    cwd,
    remoteUrl,
    options.workspaceId,
    fetchImpl,
    stderr,
  );

  // Environment parity ("feel at home"): the project mounts at its real local
  // path inside the Pod and HOME is reproduced, so the resumed conversation's
  // absolute paths (cwd, file refs) resolve identically. Persisted on the
  // workspace marker so every session bound to it is path-identical.
  const home = marker.home ?? homedir();
  const workspacePath = marker.path ?? cwd;
  if (marker.path === undefined || marker.home === undefined) {
    writeWorkspaceMarker(cwd, { ...marker, path: workspacePath, home });
  }

  // Resume the EXACT conversation by id so the remote CLI loads it directly
  // instead of showing its interactive picker. `resume === true` ("most recent")
  // is resolved to the local conversation id — which matches what the agent
  // restores in the Pod thanks to path parity (same project-dir encoding).
  let resolvedResume = resume;
  if (resume === true) {
    const cid = newestLocalConvId(cwd, profile, home);
    if (cid) resolvedResume = cid;
  }

  if (options.reconnect) {
    // Revive on the existing PVC: no capture, no push — the conversation and any
    // work done remotely are already on the retained workspace volume.
    stderr.write(
      `[remote] reconnect: reusing workspace ${marker.workspaceId} as-is (no push)\n`,
    );
  } else {
    // Record git origin so the Pod can clone-on-start when .git is too big to
    // ship (the size-gate in buildWorkspaceArchive skips large histories).
    writeGitMetadata(cwd, stderr);

    // When resuming, stage the live conversation so it rides the pushed archive
    // and the session-agent restores it into HOME — the remote CLI then resumes
    // exactly where the local session left off (path parity makes the project
    // dir encoding match on both sides).
    if (resume !== undefined) {
      captureLiveConversation(cwd, profile, home, stderr);
    }
    // Step 2 & 3: push workspace.
    await pushWorkspace(cwd, remoteUrl, marker.workspaceId, fetchImpl, stderr);
  }

  // Step 4: create remote session. Bundle the profile's local credentials so
  // the migrated CLI is authenticated in-pod, mirroring the `remote <profile>`
  // run path. Missing creds are tolerated (the session still starts; shell /
  // opencode need none) — we warn rather than hard-fail.
  const authFiles: Record<string, string> = { ...(await collectProfileAuth(profile)) };
  // Also bundle the auth of selected tool CLIs (scw, gh, aws, gcloud, az) so
  // they work inside the Pod — opt-in via `tools`.
  let bundledTools: string[] = [];
  if (options.tools && options.tools.length > 0) {
    const { bundle: toolBundle, bundled } = await collectToolAuth(options.tools);
    Object.assign(authFiles, toolBundle);
    bundledTools = bundled;
  }
  const credentials: Readonly<Record<string, string>> | undefined =
    Object.keys(authFiles).length > 0 ? authFiles : undefined;

  const resumeArgs =
    resolvedResume !== undefined
      ? buildResumeStartupArgs(profile, resolvedResume)
      : [];
  const session = await createRemoteSession(
    remoteUrl,
    {
      profile,
      workspaceId: marker.workspaceId,
      workspacePath,
      home,
      workspaceSync: true,
      ...(credentials ? { credentials } : {}),
      ...(resumeArgs.length > 0 ? { startupArgs: resumeArgs } : {}),
    },
    fetchImpl,
  );
  stderr.write(
    credentials
      ? `[remote] bundled ${profile} creds: ${Object.keys(credentials).join(", ")}\n`
      : `[remote] no ${profile} creds found locally — session starts unauthenticated\n`,
  );
  if (bundledTools.length > 0) {
    stderr.write(`[remote] bundled tool auth: ${bundledTools.join(", ")}\n`);
  }

  stderr.write(
    `[remote] migrated to remote session ${session.id} on ${remoteUrl} (workspace ${marker.workspaceId})\n`,
  );
  // Step 5: hand off terminal — unless --no-attach (bulk / reconnect-yourself).
  if (options.noAttach) {
    stderr.write(
      `[remote] session ready (not attached). Reconnect your terminal with:\n` +
        `    remote attach ${remoteUrl} ${session.id}\n`,
    );
    return { workspaceId: marker.workspaceId, sessionId: session.id };
  }

  stderr.write(
    `[remote] terminal is now REMOTE — press Ctrl+P Ctrl+Q to detach without stopping the session\n`,
  );
  const attached = await attach({
    baseUrl: remoteUrl,
    sessionId: session.id,
    fetchImpl,
  });
  await attached.finished;

  return { workspaceId: marker.workspaceId, sessionId: session.id };
}

/**
 * Back: pull the remote session back to local.
 *
 * Steps: pull workspace + conversation state → stop remote session → print
 * resume command.
 *
 * We do NOT spawn the local CLI — we print the resume command so the user
 * retains control of when and how they restart.
 */
export async function migrateBack(
  options: MigrateBackOptions,
): Promise<MigrateBackResult> {
  const {
    remoteUrl,
    onConflict = "block",
    fetchImpl = fetch,
    cwd = process.cwd(),
    home = process.env.HOME ?? "",
    stderr = process.stderr,
    stdout = process.stdout,
  } = options;

  // Step 1: resolve workspace.
  const existing = readWorkspaceMarker(cwd);
  const workspaceId = options.workspaceId ?? existing?.workspaceId;
  if (!workspaceId) {
    throw new Error(
      "No workspace mapped for this directory and no --workspace given. Run `remote workspace link` first or pass --workspace <id>.",
    );
  }

  // Step 2: pull workspace + conversation state.
  const { remoteArchive, hasConflicts } = await pullWorkspace(
    cwd,
    home,
    remoteUrl,
    workspaceId,
    onConflict,
    fetchImpl,
    stderr,
  );

  // Step 3: stop the remote session for this workspace.
  // List sessions and find the one bound to our workspace.
  let stoppedSessionId: string | undefined;
  try {
    const { listRemoteSessions } = await import("./attach.js");
    const sessions = await listRemoteSessions(remoteUrl, fetchImpl);
    // The session-agent sets cliSessionId or we can match by workspace
    // via the session list. The workspace id is not currently returned in the
    // list response, so we stop the most-recent session for any profile that
    // has a cliSessionId matching. As a best-effort, we stop the newest
    // session for any profile (user should have only one open per workspace).
    if (sessions.length > 0) {
      // Sort by createdAt descending (ISO strings sort lexicographically).
      const sorted = [...sessions].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const target = sorted[0]!;
      await stopRemoteSession(remoteUrl, target.id, "migrate-back", fetchImpl);
      stoppedSessionId = target.id;
      stderr.write(`[remote] stopped remote session ${target.id}\n`);
    }
  } catch (err) {
    stderr.write(
      `[remote] warning: could not stop remote session: ${String(err)}\n`,
    );
  }

  // Step 4: derive and print resume command.
  // Pick a profile from the restored archive — use the first CLI profile that
  // has session state in the archive; fall back to the session's profile if
  // available.
  let resumeProfile: string | undefined;
  let resumeConvId: string | undefined;

  if (remoteArchive) {
    // Peek at which profiles have session state in the archive.
    // (restoreSessionsToLocal already ran — we just need to know the profile.)
    for (const p of CLI_PROFILES) {
      const r = restoreSessionsToLocal({
        home,
        profile: p,
        remoteArchive,
        onConflict: "keep-local", // dry-run: don't overwrite again
      });
      // Pick profile that has the most restored/kept items.
      if (r.restored.length + r.keptLocal.length > 0) {
        resumeProfile = p;
        // The restored conversation id is not trivially extractable here;
        // we fall back to the generic --resume / --continue flag without an id.
        break;
      }
    }
  }

  const finalProfile = resumeProfile ?? "claude";
  const profileConfig = resolveProfile(finalProfile);
  const resumeFlag = profileConfig.resumeFlag;
  const resumeCommand = resumeConvId
    ? `remote ${finalProfile} ${resumeFlag} ${resumeConvId}`
    : resumeFlag
      ? `remote ${finalProfile} ${resumeFlag}`
      : `remote ${finalProfile}`;

  stdout.write(`\n[remote] local state restored from workspace ${workspaceId}\n`);
  stdout.write(`[remote] resume your session with:\n\n  ${resumeCommand}\n\n`);

  return {
    workspaceId,
    ...(stoppedSessionId !== undefined ? { stoppedSessionId } : {}),
    resumeCommand,
    hasConflicts,
  };
}
