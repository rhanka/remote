import { CLI_PROFILES, type CliProfile } from "@sentropic/remote-protocol";

export type ProfileConfig = {
  readonly profile: CliProfile;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

const DEFAULT_PROFILES: Readonly<Record<CliProfile, ProfileConfig>> = {
  shell: { profile: "shell", command: "/bin/bash", args: [] },
  codex: { profile: "codex", command: "codex", args: [] },
  opencode: { profile: "opencode", command: "opencode", args: [] },
  claude: { profile: "claude", command: "claude", args: [] },
  agy: { profile: "agy", command: "agy", args: [] },
};

/**
 * Per-profile resume argv. A single flag string cannot express this:
 * - codex resumes via a SUBCOMMAND (`codex resume <id>`, `resume --last` for
 *   the most recent) which must LEAD the argv;
 * - claude's bare `--resume` opens an interactive picker (useless headless in
 *   a pod) — the most-recent form is `--continue`, explicit is `--resume <id>`;
 * - agy follows claude's shape (`--resume <id>` / `--continue`).
 */
export function resumeArgsFor(
  config: ProfileConfig,
  sessionId: string | true,
): string[] {
  switch (config.profile) {
    case "codex":
      return sessionId === true ? ["resume", "--last"] : ["resume", sessionId];
    case "claude":
    case "agy":
      return sessionId === true ? ["--continue"] : ["--resume", sessionId];
    default:
      return [];
  }
}

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
  const extra = resumeArgsFor(config, sessionId);
  if (extra.length === 0) return config;
  // codex's `resume` is a subcommand — it must lead the argv; flags append.
  const args =
    config.profile === "codex"
      ? [...extra, ...config.args]
      : [...config.args, ...extra];
  return { ...config, args };
}
