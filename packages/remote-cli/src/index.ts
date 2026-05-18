#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  attach,
  createRemoteSession,
  listRemoteSessions,
  stopRemoteSession,
} from "./attach.js";
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
import { coerceCliProfileName, isCliProfile } from "./profiles.js";
import { run } from "./run.js";
import { smokeRemoteProfile } from "./smoke.js";

export const packageName = "@sentropic/remote-cli";

export { run } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";
export {
  attach,
  createRemoteSession,
  listRemoteSessions,
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
  resume?: string;
  port?: number;
  remote?: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  auth?: boolean;
  authRefresh?: boolean;
};

type AuthDiagnosticOpts = {
  authRefresh?: boolean;
};

type SmokeOpts = {
  remote: string;
  target?: "k3s" | "scaleway-kapsule" | "gke";
  timeout?: number;
  auth?: boolean;
  authRefresh?: boolean;
};

function describeAuthStatus(status: AuthDiagnosticsStatus): string {
  if (status.checked) return `ok: ${status.command}`;
  return `skipped: ${status.reason}`;
}

async function runProfile(
  profileName: string,
  opts: ProfileOpts,
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
    const sessionId =
      opts.resume ??
      (
        await createRemoteSession(opts.remote, {
          profile: profileName,
          target: opts.target ?? "k3s",
          ...(credentials ? { credentials } : {}),
        })
      ).id;
    if (credentials) {
      process.stderr.write(
        `[remote] bundled ${Object.keys(credentials).length} auth file(s) for ${profileName}\n`,
      );
    }
    process.stderr.write(
      `[remote] attached to ${opts.remote}/sessions/${sessionId}\n`,
    );
    const session = await attach({ baseUrl: opts.remote, sessionId });
    await session.finished;
    return;
  }
  const runOptions: import("./run.js").RunOptions = {
    profile: profileName,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  };
  const result = await run(runOptions);
  process.stderr.write(
    `[remote] session ${result.sessionId} attach at http://127.0.0.1:${result.port}\n`,
  );
  const { exitCode } = await result.exit;
  process.exitCode = exitCode;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const program = new Command();
  program
    .name("remote")
    .description(
      "Wrap a local agent CLI (codex/claude/gemini) and expose its session for remote attach.",
    )
    .version("0.0.0");

  for (const [profileName, alias] of [
    ["codex", undefined],
    ["claude-code", "claude"],
    ["gemini-cli", "gemini"],
    ["opencode", undefined],
    ["shell", undefined],
  ] as const) {
    const cmd = program
      .command(profileName)
      .description(`Run ${profileName} via remote-cli`)
      .option("-r, --resume <id>", "resume an existing session id")
      .option(
        "-p, --port <port>",
        "expose the in-process control-plane on this port",
        (value) => Number(value),
      )
      .option(
        "--remote <url>",
        "create the session on a remote control-plane and attach instead of running locally",
      )
      .option(
        "--target <target>",
        "remote session target: k3s, scaleway-kapsule, or gke",
        "k3s",
      )
      .option(
        "--no-auth",
        "skip bundling local credentials when running with --remote",
      )
      .option(
        "--no-auth-refresh",
        "skip local auth status preflight before bundling credentials",
      )
      .action(async (opts: ProfileOpts) => {
        await runProfile(profileName, opts);
      });
    if (alias) cmd.alias(alias);
  }

  program
    .command("auth <profile>")
    .description("Check local auth status and bundled credential files")
    .option(
      "--no-auth-refresh",
      "skip local auth status preflight and only inspect bundled files",
    )
    .action(async (profileName: string, opts: AuthDiagnosticOpts) => {
      const profile = coerceCliProfileName(profileName);
      if (!profile) {
        throw new Error(
          `Unknown profile "${profileName}". Known: codex, claude, claude-code, gemini, gemini-cli, opencode, shell`,
        );
      }
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
    });

  program
    .command("smoke <profile>")
    .description(
      "Create a remote profile session, wait for terminal.opened, then stop it",
    )
    .requiredOption(
      "--remote <url>",
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
    .action(async (profileName: string, opts: SmokeOpts) => {
      const profile = coerceCliProfileName(profileName);
      if (!profile) {
        throw new Error(
          `Unknown profile "${profileName}". Known: codex, claude, claude-code, gemini, gemini-cli, opencode, shell`,
        );
      }
      const result = await smokeRemoteProfile({
        profile,
        baseUrl: opts.remote,
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
    });

  program
    .command("attach <url> <sessionId>")
    .description("Attach to an existing session on a remote control-plane")
    .action(async (url: string, sessionId: string) => {
      process.stderr.write(
        `[remote] attaching to ${url}/sessions/${sessionId}\n`,
      );
      const session = await attach({ baseUrl: url, sessionId });
      await session.finished;
    });

  program
    .command("ls <url>")
    .description("List sessions on a remote control-plane")
    .action(async (url: string) => {
      const sessions = await listRemoteSessions(url);
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
    .command("stop <url> <sessionId>")
    .description("Stop a session on a remote control-plane")
    .option("--reason <reason>", "reason recorded with the stop")
    .action(
      async (url: string, sessionId: string, opts: { reason?: string }) => {
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
