import { spawn } from "node:child_process";

import type { CliProfile } from "./protocol-local.js";

type AuthStatusCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly refreshHint: string;
};

const PROFILE_AUTH_STATUS: Partial<Record<CliProfile, AuthStatusCommand>> = {
  codex: {
    command: "codex",
    args: ["login", "status"],
    refreshHint: "codex login",
  },
  claude: {
    command: "claude",
    args: ["auth", "status"],
    refreshHint: "claude auth login",
  },
};

export type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
};

export type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { timeoutMs: number },
) => Promise<CommandResult>;

export type AuthRefreshResult =
  | { readonly checked: true; readonly command: string }
  | { readonly checked: false; readonly reason: "no-status-command" };

export type EnsureAuthFreshOptions = {
  readonly timeoutMs?: number;
  readonly runCommand?: RunCommand;
};

export class AuthRefreshError extends Error {
  constructor(
    readonly profile: CliProfile,
    readonly refreshHint: string,
    readonly result: CommandResult,
  ) {
    const detail = result.timedOut
      ? "status check timed out"
      : `status check failed with exit ${result.status}`;
    super(
      `[remote] ${profile} auth is not ready to bundle (${detail}). ` +
        `Run \`${refreshHint}\` locally, then retry; or use --no-auth-refresh to bypass this preflight.`,
    );
    this.name = "AuthRefreshError";
  }
}

export function runStatusCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let timedOut = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({
        status: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: String(error),
      });
    });
    child.on("close", (code) => {
      finish({
        status: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(timedOut ? { timedOut } : {}),
      });
    });
  });
}

export async function ensureProfileAuthFresh(
  profile: CliProfile,
  options: EnsureAuthFreshOptions = {},
): Promise<AuthRefreshResult> {
  const statusCommand = PROFILE_AUTH_STATUS[profile];
  if (!statusCommand) return { checked: false, reason: "no-status-command" };

  const runner = options.runCommand ?? runStatusCommand;
  const result = await runner(statusCommand.command, statusCommand.args, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (result.status === 0) {
    return {
      checked: true,
      command: [statusCommand.command, ...statusCommand.args].join(" "),
    };
  }

  throw new AuthRefreshError(profile, statusCommand.refreshHint, result);
}
