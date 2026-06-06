#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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
  attachLocalSession,
  attachPodTmux,
  findLocalSession,
  killLocalSession,
  listLocalSessions,
  startLocalSession,
  tmuxAvailable,
} from "./tmux.js";
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
import { coerceCliProfileName, isCliProfile, resolveProfile } from "./profiles.js";
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

type ProfileOpts = {
  resume?: string | true;
  port?: number;
  remote?: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  auth?: boolean;
  authRefresh?: boolean;
  sync?: boolean;
  workspaceId?: string;
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
  const config = resolveProfile(profileName);
  if (!config.resumeFlag) return [];
  return resume === true ? [config.resumeFlag] : [config.resumeFlag, resume];
}

async function runProfile(
  profileName: string,
  opts: ProfileOpts,
  commandArgs: readonly string[] = [],
): Promise<void> {
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
      .action(async (commandArgs: string[] | undefined, opts: ProfileCliOpts) => {
        const { remote: remoteOverride, local, workspace, ...rest } = opts;
        if (local) {
          await runProfile(profileName, { ...rest }, commandArgs ?? []);
          return;
        }
        const marker =
          workspace === false ? undefined : readWorkspaceMarker(process.cwd());
        const remote = getConfiguredRemote(remoteOverride ?? marker?.remote);
        if (marker) {
          process.stderr.write(
            `[remote] cwd mapped to ${marker.workspaceId} (reusing workspace)\n`,
          );
        }
        await runProfile(
          profileName,
          {
            ...rest,
            remote,
            ...(marker ? { workspaceId: marker.workspaceId } : {}),
          },
          commandArgs ?? [],
        );
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
      "--no-auth-refresh",
      "skip the local auth status preflight before bundling",
    )
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: RefreshOpts & { all?: boolean },
      ) => {
        const { url, sessionId } = resolveUrlAndSessionId(first, second);
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
  // diff — is the remote session's conversation aligned with the local one?
  // ---------------------------------------------------------------------------

  program
    .command("diff [sessionId]")
    .description(
      "Check whether each remote session's conversation log is in sync with the latest LOCAL conversation (metrics only — content never transferred)",
    )
    .option("--remote <url>", "control-plane URL (defaults to configured remote)")
    .action(async (sessionId: string | undefined, opts: { remote?: string }) => {
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
        const local = localConvStat(s.workspacePath);
        const remote = remoteConvStat(s.id, s.workspacePath);
        const v = alignment(local, remote);
        process.stdout.write(
          `${(icon[v.state] ?? v.state).padEnd(14)} ${projectName(s).padEnd(18)} ${v.detail}\n`,
        );
      }
    });

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
        },
      ) => {
        const remoteUrl = getConfiguredRemote(opts.remote);
        await ensureConnected(remoteUrl);
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

  program
    .command("run <profile> [path]")
    .description(
      "Start a LOCAL session in tmux (claude/codex/…) in <path> (default: cwd). Manage it like a remote one: `remote ls`, `remote attach <slug>`, `remote stop <slug>`. Detach with Ctrl-b d; the session keeps running.",
    )
    .option("--attach", "attach immediately after starting (default: start detached)")
    .action(
      async (
        profile: string,
        path: string | undefined,
        opts: { attach?: boolean },
      ) => {
        if (!tmuxAvailable()) {
          process.stderr.write(
            "[remote] tmux is not installed locally — `remote run` needs it (e.g. `sudo apt install tmux`).\n",
          );
          process.exitCode = 1;
          return;
        }
        const cwd = path ? resolve(path) : process.cwd();
        const command = localCliCommand(profile);
        const { name, slug } = startLocalSession(profile, command, cwd);
        process.stderr.write(
          `[remote] local session ${slug} started (${profile} in ${cwd})\n`,
        );
        if (opts.attach) {
          attachLocalSession(name);
          return;
        }
        process.stderr.write(
          `[remote] attach with: remote attach ${slug}\n`,
        );
      },
    );

  program
    .command("attach <urlOrSessionId> [sessionId]")
    .description(
      "Attach to a session. Resolves a LOCAL tmux session (by slug) first, otherwise a remote session on the control-plane. URL is optional when a default remote is configured.",
    )
    .option(
      "--exec",
      "attach to a remote session straight via kubectl exec into the Pod's tmux (native scrollback + copy; needs a tmux-backed session)",
    )
    .option("--local", "force local tmux lookup")
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: { exec?: boolean; local?: boolean },
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
        if (opts.exec) {
          const tunnel = getTunnel();
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
          `[remote] attaching to ${url}/sessions/${sessionId}\n`,
        );
        const session = await attach({ baseUrl: url, sessionId });
        await session.finished;
      },
    );

  program
    .command("refresh <urlOrSessionId> [sessionId]")
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
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: RefreshOpts,
      ) => {
        const { url, sessionId } = resolveUrlAndSessionId(first, second);
        await refreshProfileSession(url, sessionId, opts);
      },
    );

  program
    .command("ls [url]")
    .description("List sessions — LOCAL (tmux) and REMOTE (control-plane) — uniformly")
    .option("--local", "list only local tmux sessions (no control-plane call)")
    .action(async (url: string | undefined, opts: { local?: boolean }) => {
      const w = (s: string, n: number) => s.padEnd(n);
      const local = listLocalSessions();

      if (local.length > 0) {
        process.stdout.write("LOCAL (tmux)\n");
        process.stdout.write(
          `  ${w("PROJECT", 20)} ${w("PROFILE", 7)} ${w("STATE", 9)} PATH\n`,
        );
        for (const s of local) {
          process.stdout.write(
            `  ${w(s.slug, 20)} ${w(s.profile, 7)} ${w(s.attached ? "attached" : "detached", 9)} ${s.path}\n`,
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
