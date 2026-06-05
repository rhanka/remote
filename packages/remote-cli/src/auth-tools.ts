/**
 * Auxiliary tool-CLI auth bundling. Beyond the session's primary CLI
 * (claude/codex), a deported session usually needs other authenticated CLIs
 * (scw, gh, aws, gcloud, az). This registry maps each known tool to its
 * HOME-relative auth/config files; the CLI can detect which are authenticated
 * locally (to propose them) and bundle the selected ones into the remote
 * session's Secret so they work in the Pod.
 *
 * These are sensitive (cloud secret keys, tokens) — bundling is always opt-in
 * (the user picks which tools), never automatic.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolSpec = {
  /** HOME-relative files to bundle (missing ones are skipped). */
  readonly files: ReadonlyArray<string>;
  /** How to authenticate locally, shown when the tool is not authenticated. */
  readonly loginHint: string;
};

/**
 * `present` is decided by the FIRST file (the primary credential); the rest are
 * companion config files bundled alongside when present.
 */
const TOOL_AUTH: Readonly<Record<string, ToolSpec>> = {
  scw: { files: [".config/scw/config.yaml"], loginHint: "scw init" },
  gh: { files: [".config/gh/hosts.yml"], loginHint: "gh auth login" },
  aws: { files: [".aws/credentials", ".aws/config"], loginHint: "aws configure" },
  gcloud: {
    files: [
      ".config/gcloud/application_default_credentials.json",
      ".config/gcloud/active_config",
      ".config/gcloud/credentials.db",
      ".config/gcloud/access_tokens.db",
    ],
    loginHint: "gcloud auth login && gcloud auth application-default login",
  },
  azure: {
    files: [".azure/azureProfile.json", ".azure/msal_token_cache.json"],
    loginHint: "az login",
  },
};

export const KNOWN_TOOLS = Object.keys(TOOL_AUTH);

/** Tools carrying long-lived, account-wide cloud credentials (flagged in audits). */
const BROAD_TOOLS = new Set(["aws", "gcloud", "azure"]);

/** Flattened {relpath, tool, broad} for every tool auth file — for secret audits. */
export const TOOL_AUTH_INFO: ReadonlyArray<{
  relpath: string;
  tool: string;
  broad: boolean;
}> = Object.entries(TOOL_AUTH).flatMap(([tool, spec]) =>
  spec.files.map((relpath) => ({ relpath, tool, broad: BROAD_TOOLS.has(tool) })),
);

export type ToolAuthStatus = {
  readonly tool: string;
  readonly present: boolean;
  readonly loginHint: string;
};

/** Report which known tools are authenticated locally (primary file exists). */
export function detectToolAuth(home: string = homedir()): ToolAuthStatus[] {
  return KNOWN_TOOLS.map((tool) => {
    const spec = TOOL_AUTH[tool]!;
    const present = existsSync(join(home, spec.files[0]!));
    return { tool, present, loginHint: spec.loginHint };
  });
}

/** Validate a requested tool list, returning {known, unknown}. */
export function partitionTools(requested: ReadonlyArray<string>): {
  known: string[];
  unknown: string[];
} {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const t of requested) {
    if (t in TOOL_AUTH) known.push(t);
    else unknown.push(t);
  }
  return { known, unknown };
}

/**
 * Collect the HOME-relative auth files for the given tools, base64-encoded, as a
 * credentials bundle (same shape as the profile auth bundle). Missing files are
 * skipped silently. Returns the bundle plus the list of tools that actually
 * contributed at least one file.
 */
export async function collectToolAuth(
  tools: ReadonlyArray<string>,
  home: string = homedir(),
): Promise<{ bundle: Record<string, string>; bundled: string[] }> {
  const bundle: Record<string, string> = {};
  const bundled: string[] = [];
  for (const tool of tools) {
    const spec = TOOL_AUTH[tool];
    if (!spec) continue;
    let contributed = false;
    for (const rel of spec.files) {
      try {
        const data = await readFile(join(home, rel));
        bundle[rel] = Buffer.from(data).toString("base64");
        contributed = true;
      } catch {
        // missing/unreadable file → skip
      }
    }
    // gh stores its token in the OS keyring (not hosts.yml) when login used
    // secure storage, so the bundled hosts.yml has no `oauth_token` and the Pod
    // can't auth (no keyring/dbus). Regenerate a file-based hosts.yml carrying
    // the token from `gh auth token` so the Pod authenticates without a keyring.
    if (tool === "gh") {
      const ghHosts = buildGhHostsYaml();
      if (ghHosts) {
        bundle[".config/gh/hosts.yml"] = Buffer.from(ghHosts, "utf8").toString("base64");
        contributed = true;
      }
    }
    if (contributed) bundled.push(tool);
  }
  return { bundle, bundled };
}

/**
 * Build a self-contained `~/.config/gh/hosts.yml` with the token resolved via
 * `gh auth token` (works regardless of keyring vs file storage), so the Pod's
 * gh is authenticated from the file alone — no OS keyring / dbus needed.
 */
function buildGhHostsYaml(): string | undefined {
  const token = spawnSync("gh", ["auth", "token"], { encoding: "utf8" })
    .stdout?.trim();
  if (!token) return undefined;
  const user =
    spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" })
      .stdout?.trim() || "";
  return (
    `github.com:\n` +
    `    oauth_token: ${token}\n` +
    `    git_protocol: https\n` +
    (user ? `    user: ${user}\n` : "")
  );
}
