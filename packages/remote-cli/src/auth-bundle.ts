import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CliProfile } from "@sentropic/remote-protocol";

/**
 * For each CLI profile, the set of HOME-relative files we copy to the Pod's
 * Secret so the in-cluster binary can read its OAuth credentials without
 * re-authing in-Pod.
 */
export const PROFILE_AUTH_FILES: Readonly<
  Record<CliProfile, ReadonlyArray<string>>
> = {
  shell: [],
  codex: [".codex/auth.json", ".codex/config.toml"],
  opencode: [],
  claude: [
    ".claude/.credentials.json",
    ".claude.json",
    ".claude/settings.json",
  ],
  agy: [
    ".gemini/oauth_creds.json",
    ".gemini/google_accounts.json",
    ".gemini/antigravity-cli/settings.json",
  ],
  gemini: [
    ".gemini/oauth_creds.json",
    ".gemini/google_accounts.json",
    ".gemini/settings.json",
    ".gemini/config/mcp_config.json",
  ],
  mistral: [],
};

export type AuthBundle = Readonly<Record<string, string>>;

const REQUIRED_AUTH_BUNDLE_PROFILES: Partial<Record<CliProfile, string>> = {
  codex: "codex login",
  claude: "claude auth login",
};

export class AuthBundleMissingError extends Error {
  constructor(
    readonly profile: CliProfile,
    readonly knownPaths: ReadonlyArray<string>,
    readonly refreshHint: string,
  ) {
    super(
      `[remote] No local auth files found for ${profile}. ` +
        `Expected at least one of: ${knownPaths.join(", ")}. ` +
        `Run \`${refreshHint}\` locally, then retry; or use --no-auth to start without bundled credentials.`,
    );
    this.name = "AuthBundleMissingError";
  }
}

export type CollectAuthOptions = {
  readonly home?: string;
  readonly readFileImpl?: (path: string) => Promise<Uint8Array | Buffer>;
};

export async function collectProfileAuth(
  profile: CliProfile,
  options: CollectAuthOptions = {},
): Promise<AuthBundle> {
  const home = options.home ?? homedir();
  const reader =
    options.readFileImpl ?? (async (path: string) => readFile(path));
  const files = PROFILE_AUTH_FILES[profile] ?? [];

  const bundle: Record<string, string> = {};
  for (const relPath of files) {
    try {
      const data = await reader(join(home, relPath));
      const payload =
        relPath === ".claude.json"
          ? sanitizeClaudeConfig(data)
          : relPath === ".claude/settings.json"
            ? sanitizeClaudeSettings(data)
            : Buffer.from(data);
      bundle[relPath] = payload.toString("base64");
    } catch {
      // missing auth files are skipped silently; the CLI in-Pod will fall back
      // to its own login flow.
    }
  }
  return bundle;
}

/**
 * Strip native-install metadata from a bundled ~/.claude.json. Locally claude
 * records `installMethod: "native"` + a local binary path (~/.local/bin/claude)
 * that does not exist in the remote Pod, which makes the in-Pod claude warn
 * "claude command not found". Dropping these lets the Pod's own install stand.
 */
function sanitizeClaudeConfig(data: Uint8Array | Buffer): Buffer {
  try {
    const obj = JSON.parse(Buffer.from(data).toString("utf8")) as Record<
      string,
      unknown
    >;
    delete obj.installMethod;
    delete obj.autoUpdaterStatus;
    return Buffer.from(JSON.stringify(obj), "utf8");
  } catch {
    return Buffer.from(data);
  }
}

/**
 * Strip host/launcher-specific `hooks` from a bundled ~/.claude/settings.json.
 * `remote enroll --install-hooks` registers SessionStart/SessionEnd hooks that
 * shell out to the `remote` CLI — which exists on the laptop but NOT inside a
 * session Pod. Shipping them verbatim makes the in-Pod claude fail every
 * SessionStart with "SessionStart:resume hook error … /bin/sh: 1: remote: not
 * found". The hooks are a local-launcher concern, so they never belong in a Pod.
 */
function sanitizeClaudeSettings(data: Uint8Array | Buffer): Buffer {
  try {
    const obj = JSON.parse(Buffer.from(data).toString("utf8")) as Record<
      string,
      unknown
    >;
    delete obj.hooks;
    return Buffer.from(JSON.stringify(obj), "utf8");
  } catch {
    return Buffer.from(data);
  }
}

export function assertRequiredAuthBundle(
  profile: CliProfile,
  bundle: AuthBundle,
): void {
  const refreshHint = REQUIRED_AUTH_BUNDLE_PROFILES[profile];
  if (!refreshHint || Object.keys(bundle).length > 0) return;
  throw new AuthBundleMissingError(
    profile,
    PROFILE_AUTH_FILES[profile] ?? [],
    refreshHint,
  );
}
