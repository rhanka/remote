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
    "claude-code": [".claude/.credentials.json"],
    "gemini-cli": [".gemini/oauth_creds.json", ".gemini/google_accounts.json"],
  };

export type AuthBundle = Readonly<Record<string, string>>;

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
