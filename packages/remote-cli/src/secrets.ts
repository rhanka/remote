/**
 * Secret audit — what auth/credentials were actually transmitted to a session.
 *
 * Source of truth is the LIVE per-session Kubernetes Secret (`session-<id>-auth`)
 * read via kubectl over the configured tunnel — NEVER a local "what I sent"
 * record (which drifts on refresh / a second machine / a control-plane restart).
 * Only KEY NAMES are read (go-template emits keys, never values); values are
 * never decoded or printed. Sanitized Secret keys are mapped back to their
 * original home-relative paths via the known auth registries, and classified by
 * tool with a "broad" flag for account-wide cloud creds.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { getTunnel } from "./config.js";
import { PROFILE_AUTH_FILES } from "./auth-bundle.js";
import { TOOL_AUTH_INFO } from "./auth-tools.js";

/** Same sanitization the orchestrator applies to Secret keys (spec.ts). */
function credentialSecretKey(relativePath: string): string {
  return relativePath.replace(/^\.+/, "").replace(/\//g, "_");
}

type RelpathInfo = { relpath: string; tool: string; broad: boolean };

/** sanitizedSecretKey → {relpath, tool, broad} for every auth file we ever bundle. */
function knownKeyMap(): Map<string, RelpathInfo> {
  const m = new Map<string, RelpathInfo>();
  for (const [profile, files] of Object.entries(PROFILE_AUTH_FILES)) {
    for (const rel of files) {
      m.set(credentialSecretKey(rel), { relpath: rel, tool: profile, broad: false });
    }
  }
  for (const info of TOOL_AUTH_INFO) {
    m.set(credentialSecretKey(info.relpath), { ...info });
  }
  return m;
}

export type SecretEntry = {
  /** Original home-relative path (or the raw Secret key if unrecognized). */
  readonly path: string;
  readonly tool: string;
  readonly broad: boolean;
};

function kubeEnv(): NodeJS.ProcessEnv | undefined {
  const tunnel = getTunnel();
  if (!tunnel) return undefined;
  const env = { ...process.env };
  if (tunnel.kubeconfig) {
    env.KUBECONFIG = tunnel.kubeconfig.startsWith("~")
      ? join(homedir(), tunnel.kubeconfig.slice(1))
      : tunnel.kubeconfig;
  }
  return env;
}

/**
 * Read the auth-Secret KEY NAMES transmitted to a session (values never read).
 * Returns undefined if there is no configured tunnel / the secret can't be read.
 */
export function transmittedSecrets(sessionId: string): SecretEntry[] | undefined {
  const tunnel = getTunnel();
  const env = kubeEnv();
  if (!tunnel || !env) return undefined;
  const r = spawnSync(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "get",
      "secret",
      `session-${sessionId}-auth`,
      // emit ONLY the keys — the value ($v) is never referenced/printed
      "-o",
      'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}',
    ],
    { encoding: "utf8", env },
  );
  if (r.status !== 0) return undefined;
  const map = knownKeyMap();
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const info = map.get(raw);
      return info
        ? { path: info.relpath, tool: info.tool, broad: info.broad }
        : { path: raw, tool: "?", broad: false };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** One-line summary for `remote status` (e.g. "claude +scw +aws⚠", or "—"). */
export function secretsSummary(sessionId: string): string {
  const entries = transmittedSecrets(sessionId);
  if (entries === undefined) return "?";
  if (entries.length === 0) return "—";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of entries) {
    if (seen.has(e.tool)) continue;
    seen.add(e.tool);
    parts.push(`${e.tool}${e.broad ? "⚠" : ""}`);
  }
  return parts.join(" ");
}
