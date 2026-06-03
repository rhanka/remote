import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CliProfile } from "@sentropic/remote-protocol";

/**
 * For each CLI profile, the set of HOME-relative files we copy to the Pod's
 * Secret so the in-cluster binary can read its OAuth credentials without
 * re-authing in-Pod.
 */
const PROFILE_AUTH_FILES: Readonly<Record<CliProfile, ReadonlyArray<string>>> =
  {
    shell: [],
    codex: [".codex/auth.json", ".codex/config.toml"],
    opencode: [],
    claude: [".claude/.credentials.json", ".claude.json"],
    agy: [
      ".gemini/oauth_creds.json",
      ".gemini/google_accounts.json",
      ".gemini/antigravity-cli/settings.json",
    ],
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
      bundle[relPath] = Buffer.from(data).toString("base64");
    } catch {
      // missing auth files are skipped silently; the CLI in-Pod will fall back
      // to its own login flow.
    }
  }
  return bundle;
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
