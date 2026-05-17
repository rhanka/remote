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
import { AuthRefreshError, ensureProfileAuthFresh } from "./auth-refresh.js";
import { collectProfileAuth } from "./auth-bundle.js";
import { isCliProfile } from "./profiles.js";
import { run } from "./run.js";

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
export { AuthRefreshError, ensureProfileAuthFresh } from "./auth-refresh.js";
export { collectProfileAuth } from "./auth-bundle.js";
export type { AuthBundle } from "./auth-bundle.js";
export {
  resolveProfile,
  isCliProfile,
  withResume,
  type ProfileConfig,
} from "./profiles.js";

type ProfileOpts = {
  resume?: string;
  port?: number;
  remote?: string;
  auth?: boolean;
  authRefresh?: boolean;
};

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
      if (Object.keys(bundle).length > 0) credentials = bundle;
    }
    const sessionId =
      opts.resume ??
      (
        await createRemoteSession(opts.remote, {
          profile: profileName,
          target: "k3s",
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
    if (error instanceof AuthRefreshError) {
      console.error(error.message);
    } else {
      console.error("[remote] fatal:", error);
    }
    process.exitCode = 1;
  });
}
