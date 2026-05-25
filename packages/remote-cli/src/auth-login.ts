import { spawn } from "node:child_process";

import type { CliProfile } from "@sentropic/remote-protocol";

export type LoginCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

/**
 * The local enrollment command for each profile that ships a non-interactive
 * (or terminal-driven) login. Profiles without an entry authenticate through
 * their own in-CLI flow (e.g. `agy` opens a browser / prints an SSH-mode URL).
 */
const PROFILE_LOGIN: Partial<Record<CliProfile, LoginCommand>> = {
  codex: { command: "codex", args: ["login"] },
  claude: { command: "claude", args: ["auth", "login"] },
};

export function getLoginCommand(profile: CliProfile): LoginCommand | undefined {
  return PROFILE_LOGIN[profile];
}

export type RunInteractive = (cmd: LoginCommand) => Promise<number>;

export function runInteractiveLogin(cmd: LoginCommand): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, [...cmd.args], { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
