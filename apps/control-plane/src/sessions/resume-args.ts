import type { CliProfile, SessionDescriptor } from "@sentropic/remote-protocol";

/**
 * Rewrite a session's startup args so its wrapped CLI resumes the FRESHEST
 * known conversation, not the one frozen at creation time.
 *
 * Why: `descriptor.metadata.startup.args` is captured when the session is
 * created (e.g. `["--resume", "<convId-at-migration>"]`). The conversation
 * then advances — or forks into a NEW conversation file — inside the Pod, and
 * the session-agent keeps reporting the current cliSessionId back to the
 * control-plane. A refresh (Pod delete+create) that replays the ORIGINAL args
 * would resume the stale conversation file and silently drop everything since.
 * So the refresh path substitutes the freshest cliSessionId into the resume
 * couple before regenerating the Pod.
 */

type ResumeProfileSpec = {
  /**
   * Tokens that introduce a conversation id: the NEXT arg (when it is not
   * another flag) is the id to refresh. Mirrors what this repo actually
   * generates: profiles.ts resumeFlag (`--resume` for claude, `--continue`
   * for codex/agy) and soft-refresh.ts (`codex resume <id>` subcommand).
   */
  readonly valueTokens: readonly string[];
  /** Canonical resume couple to add when no resume token is present at all. */
  readonly addForm: (cliSessionId: string) => readonly string[];
  /**
   * Where the added couple goes. `codex resume <id>` is a SUBCOMMAND and must
   * lead the argv; claude/agy flags can trail.
   */
  readonly addPosition: "prepend" | "append";
};

const RESUME_PROFILES: Partial<Record<CliProfile, ResumeProfileSpec>> = {
  claude: {
    valueTokens: ["--resume", "-r"],
    addForm: (id) => ["--resume", id],
    addPosition: "append",
  },
  agy: {
    valueTokens: ["--resume", "--continue"],
    addForm: (id) => ["--resume", id],
    addPosition: "append",
  },
  codex: {
    valueTokens: ["resume", "--continue"],
    addForm: (id) => ["resume", id],
    addPosition: "prepend",
  },
};

export type FreshResumeResult = {
  readonly args: readonly string[];
  /**
   * - `substituted`: an existing `<resumeToken> <staleId>` couple got the fresh id
   * - `inserted`: a bare resume token (picker / most-recent form) got the id
   * - `added`: no resume token at all — the canonical couple was added
   * - `unchanged`: already fresh, or the profile has no resume concept
   */
  readonly action: "substituted" | "inserted" | "added" | "unchanged";
  /** The stale conversation id that was replaced (substituted only). */
  readonly previous?: string;
};

/**
 * Pure rewrite of `args` so the profile's CLI resumes `cliSessionId`.
 * Everything except the resume couple is preserved verbatim, order included.
 * Profiles without resume support (shell, opencode) are returned unchanged.
 */
export function applyFreshResume(
  profile: string,
  args: readonly string[],
  cliSessionId: string,
): FreshResumeResult {
  const spec = RESUME_PROFILES[profile as CliProfile];
  if (!spec) return { args, action: "unchanged" };

  for (let i = 0; i < args.length; i++) {
    if (!spec.valueTokens.includes(args[i]!)) continue;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("-")) {
      if (value === cliSessionId) return { args, action: "unchanged" };
      const next = [...args];
      next[i + 1] = cliSessionId;
      return { args: next, action: "substituted", previous: value };
    }
    // Bare resume token (end of argv, or followed by another flag): the id
    // slot is empty — fill it so the refresh resumes deterministically
    // instead of re-opening an interactive picker in a fresh Pod.
    const next = [...args];
    next.splice(i + 1, 0, cliSessionId);
    return { args: next, action: "inserted" };
  }

  const couple = spec.addForm(cliSessionId);
  const next =
    spec.addPosition === "prepend" ? [...couple, ...args] : [...args, ...couple];
  return { args: next, action: "added" };
}

/**
 * Extract the startup args from `descriptor.metadata.startup.args` — the EXACT
 * location `buildSessionPodSpec` reads to populate SESSION_STARTUP_ARGS (same
 * defensive shape checks).
 */
export function startupArgsOf(descriptor: SessionDescriptor): string[] {
  const startup = descriptor.metadata?.startup;
  if (!startup || typeof startup !== "object") return [];
  const args = (startup as { args?: unknown }).args;
  if (!Array.isArray(args)) return [];
  return args.filter((value): value is string => typeof value === "string");
}

export type DescriptorResumeResult = {
  readonly descriptor: SessionDescriptor;
  readonly action: FreshResumeResult["action"];
  readonly previous?: string;
};

/**
 * Return a descriptor whose startup args resume the freshest cliSessionId the
 * store knows. When nothing changes (no cliSessionId reported yet — e.g. an
 * old agent — or the args are already fresh) the ORIGINAL descriptor object is
 * returned so callers can cheaply detect the no-op and keep today's behavior.
 */
export function descriptorWithFreshResume(
  descriptor: SessionDescriptor,
): DescriptorResumeResult {
  const cliSessionId = descriptor.cliSessionId;
  if (cliSessionId === undefined) return { descriptor, action: "unchanged" };
  const result = applyFreshResume(
    descriptor.profile,
    startupArgsOf(descriptor),
    cliSessionId,
  );
  if (result.action === "unchanged") return { descriptor, action: "unchanged" };
  const startup = descriptor.metadata?.startup;
  const next: SessionDescriptor = {
    ...descriptor,
    metadata: {
      ...(descriptor.metadata ?? {}),
      startup: {
        ...(startup && typeof startup === "object" ? startup : {}),
        args: [...result.args],
      },
    },
  };
  return {
    descriptor: next,
    action: result.action,
    ...(result.previous !== undefined ? { previous: result.previous } : {}),
  };
}
