import { CLI_PROFILES, type CliProfile } from "@sentropic/remote-protocol";

export type ProfileConfig = {
  readonly profile: CliProfile;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly resumeFlag?: string;
};

const DEFAULT_PROFILES: Readonly<Record<CliProfile, ProfileConfig>> = {
  shell: { profile: "shell", command: "/bin/bash", args: [] },
  codex: {
    profile: "codex",
    command: "codex",
    args: [],
    resumeFlag: "--continue",
  },
  opencode: { profile: "opencode", command: "opencode", args: [] },
  "claude-code": {
    profile: "claude-code",
    command: "claude",
    args: [],
    resumeFlag: "--resume",
  },
  "gemini-cli": {
    profile: "gemini-cli",
    command: "gemini",
    args: [],
    resumeFlag: "--resume",
  },
};

export function isCliProfile(value: string): value is CliProfile {
  return (CLI_PROFILES as ReadonlyArray<string>).includes(value);
}

export function resolveProfile(name: string): ProfileConfig {
  if (!isCliProfile(name)) {
    throw new Error(
      `Unknown profile "${name}". Known: ${CLI_PROFILES.join(", ")}`,
    );
  }
  const config = DEFAULT_PROFILES[name];
  return config;
}

export function withResume(
  config: ProfileConfig,
  sessionId?: string,
): ProfileConfig {
  if (!sessionId || !config.resumeFlag) return config;
  return {
    ...config,
    args: [...config.args, config.resumeFlag, sessionId],
  };
}
