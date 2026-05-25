#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  attach,
  createRemoteSession,
  getRemoteSession,
  listRemoteSessions,
  refreshRemoteSession,
  stopRemoteSession,
} from "./attach.js";
import {
  clearDefaultRemote,
  getDefaultRemote,
  setDefaultRemote,
} from "./config.js";
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
import { run } from "./run.js";
import { smokeRemoteProfile } from "./smoke.js";

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

type ProfileOpts = {
  resume?: string | true;
  port?: number;
  remote?: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  auth?: boolean;
  authRefresh?: boolean;
  sync?: boolean;
};

type ProfileCliOpts = ProfileOpts & {
  local?: boolean;
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
      target: opts.target ?? "k3s",
      ...(startupArgs.length > 0 ? { startupArgs } : {}),
      ...(credentials ? { credentials } : {}),
      ...(opts.sync ? { workspaceSync: true } : {}),
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
        (value) => Number(value),
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
        const { remote: remoteOverride, local, ...rest } = opts;
        if (local) {
          await runProfile(profileName, { ...rest }, commandArgs ?? []);
          return;
        }
        const remote = getConfiguredRemote(remoteOverride);
        await runProfile(
          profileName,
          { ...rest, remote },
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
      target: opts.target ?? "k3s",
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
    .command("clear")
    .description("Clear default remote URL")
    .action(() => {
      clearDefaultRemote();
      process.stderr.write("[remote] cleared default remote\n");
    });

  configCommand
    .command("show")
    .description("Display configured default remote URL")
    .action(() => {
      const remote = getDefaultRemote();
      if (remote) {
        process.stdout.write(`${remote}\n`);
      } else {
        process.stdout.write("[remote] no default remote configured\n");
      }
    });

  program
    .command("attach <urlOrSessionId> [sessionId]")
    .description(
      "Attach to an existing session on a remote control-plane. URL is optional when a default remote is configured.",
    )
    .action(async (first: string, second: string | undefined) => {
      const { url, sessionId } = resolveUrlAndSessionId(first, second);
      process.stderr.write(
        `[remote] attaching to ${url}/sessions/${sessionId}\n`,
      );
      const session = await attach({ baseUrl: url, sessionId });
      await session.finished;
    });

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
    .description("List sessions on a remote control-plane")
    .action(async (url: string | undefined) => {
      const sessions = await listRemoteSessions(getConfiguredRemote(url));
      if (sessions.length === 0) {
        process.stderr.write("[remote] no sessions\n");
        return;
      }
      const rows = sessions.map((s) =>
        [s.id, s.profile, s.target, s.createdAt, s.displayName ?? ""].join(
          "\t",
        ),
      );
      process.stdout.write(
        ["ID\tPROFILE\tTARGET\tCREATED\tDISPLAY", ...rows].join("\n") + "\n",
      );
    });

  program
    .command("stop <urlOrSessionId> [sessionId]")
    .description(
      "Stop a session on a remote control-plane. URL is optional when a default remote is configured.",
    )
    .option("--reason <reason>", "reason recorded with the stop")
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: { reason?: string },
      ) => {
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
