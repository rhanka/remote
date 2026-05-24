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
  claude: {
    profile: "claude",
    command: "claude",
    args: [],
    resumeFlag: "--resume",
  },
  agy: {
    profile: "agy",
    command: "agy",
    args: [],
    resumeFlag: "--continue",
  },
};

const PROFILE_ALIASES: Readonly<Record<string, CliProfile>> = {
  "claude-code": "claude",
  antigravity: "agy",
};

export function isCliProfile(value: string): value is CliProfile {
  return (CLI_PROFILES as ReadonlyArray<string>).includes(value);
}

export function coerceCliProfileName(value: string): CliProfile | undefined {
  if (isCliProfile(value)) return value;
  return PROFILE_ALIASES[value];
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
  sessionId?: string | true,
): ProfileConfig {
  if (sessionId === undefined) return config;
  if (!config.resumeFlag) return config;
  const flag = config.resumeFlag;
  const extra = sessionId === true ? [flag] : [flag, sessionId];
  return {
    ...config,
    args: [...config.args, ...extra],
  };
}
