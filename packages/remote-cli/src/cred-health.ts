/**
 * Credential RELIABILITY pure cores (remote supervise slice 2) — ADDITIVE ONLY.
 *
 * Remote Pods silently lose auth (claude / gh / npm / docker → 401). The
 * `creds refresh --watch` loop pushes fresh local creds, but (a) it can't tell a
 * Pod-side credential already expired, (b) nobody notices when the watcher
 * itself stopped, (c) the local claude OAuth token expires roughly every 8h and
 * only `claude` running LOCALLY can refresh it.
 *
 * This module is PURE (no IO, no clock unless injected): the watch loop / `ls`
 * call these to DECIDE; the actual push reuses the EXISTING soft-refresh path
 * unchanged. NOTHING here ever prints or logs a secret VALUE — tool names and
 * ok/reason only.
 */

/** Tools whose Pod-side auth is CHEAP to probe (a non-mutating status check). */
export type ProbeableTool = "gh" | "npm" | "docker";

/** Is `tool` one we can cheaply health-probe in the Pod? (NOT claude/codex.) */
export function isProbeableTool(tool: string): tool is ProbeableTool {
  return tool === "gh" || tool === "npm" || tool === "docker";
}

/** All cheap-to-probe tools, in a stable order. */
export const PROBEABLE_TOOLS: ReadonlyArray<ProbeableTool> = ["gh", "npm", "docker"];

/**
 * The ARGV (never a `bash -lc` string) to health-probe a tool's auth INSIDE the
 * Pod, run through the existing `kubectl exec … -- <argv>` plumbing. Each is a
 * READ-ONLY status check that fails (non-zero, or an unauth marker on stdout)
 * when the Pod's credential is missing/expired:
 *  - gh:     `gh auth status`        — non-zero when not logged in.
 *  - npm:    `npm whoami`            — non-zero / empty when the token is invalid.
 *  - docker: read `~/.docker/config.json` and check it carries at least one
 *            `auths` entry (a pure config presence check — we do NOT hit a
 *            registry, which would need a target + network and could mutate
 *            nothing useful; a missing/empty config is the real 401 signal).
 *
 * The argv is built from STATIC tokens only (no untrusted interpolation), so it
 * is safe to pass straight to `kubectl exec`. Pure, exported for tests.
 */
export function buildHealthProbeCommand(tool: ProbeableTool): string[] {
  switch (tool) {
    case "gh":
      return ["gh", "auth", "status"];
    case "npm":
      return ["npm", "whoami"];
    case "docker":
      // No `docker` binary nor daemon is guaranteed in the runtime image, and a
      // real registry login would need a target + network. The 401-equivalent
      // we CAN cheaply detect is "the Pod has no usable docker auth config", so
      // we test for a config.json carrying a non-empty `auths` object. node is
      // always present in the session-agent image. Static argv — the inline
      // node script contains no interpolated/untrusted data.
      return [
        "node",
        "-e",
        'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.docker/config.json","utf8"));const a=c&&c.auths&&Object.keys(c.auths).length>0;process.exit(a?0:1)}catch(e){process.exit(1)}',
      ];
  }
}

export type HealthResult = {
  readonly tool: ProbeableTool;
  /** true = the Pod's credential for this tool looks valid. */
  readonly ok: boolean;
  /** Short, SECRET-FREE reason (tool/status only — never a token value). */
  readonly reason: string;
};

/**
 * Interpret a probe's exit code + stdout into `{tool, ok, reason}`. PURE.
 * `ok` is decided per tool:
 *  - any tool: a non-zero exit is a fail.
 *  - npm: even exit 0 with EMPTY stdout (no username) is treated as a fail —
 *    some npm versions print a warning and exit 0 with no name.
 *  - gh/docker: exit 0 is ok.
 * The `reason` is a fixed, secret-free phrase. We NEVER echo stdout (it may
 * carry a username/host) beyond the boolean decision.
 */
export function parseHealthResult(
  tool: ProbeableTool,
  exitCode: number,
  stdout: string,
): HealthResult {
  if (exitCode !== 0) {
    return { tool, ok: false, reason: `${tool}: probe exited ${exitCode} (not authenticated)` };
  }
  if (tool === "npm" && stdout.trim().length === 0) {
    return { tool, ok: false, reason: "npm: whoami returned no user (not authenticated)" };
  }
  return { tool, ok: true, reason: `${tool}: authenticated` };
}

// ---------------------------------------------------------------------------
// Watcher HEARTBEAT staleness → advisory (zero-risk; the highest-value piece).
// ---------------------------------------------------------------------------

/** HOME/config-dir-relative file the `creds refresh --watch` loop touches each pass. */
export const SUPERVISOR_HEARTBEAT_FILE = "supervisor-heartbeat";

/**
 * Loud advisory when the creds supervisor (`creds refresh --watch`) does not
 * appear to be running: NO heartbeat, or a heartbeat OLDER than 2× the watch
 * interval (a missed pass means the Pods are drifting toward a 401 with nobody
 * pushing). PURE — the caller stats the heartbeat file and passes its mtime (ms)
 * or undefined, the configured `intervalMs`, and `now`. Returns undefined when
 * the heartbeat is fresh. Mirrors `conductorAdvisory`. Exported for tests.
 *
 * A non-finite/zero `intervalMs` falls back to treating ANY heartbeat as fresh
 * only when present (we can't compute staleness without an interval), and warns
 * when absent.
 */
export function supervisorAdvisory(
  heartbeatMtimeMs: number | undefined,
  intervalMs: number,
  now: number = Date.now(),
): string | undefined {
  if (heartbeatMtimeMs === undefined) {
    return (
      "[remote] creds supervisor heartbeat MISSING — `remote refresh --all --watch <min>` " +
      "is not running; remote Pods will drift to 401 with no fresh creds pushed. " +
      "Start it: tmux new-window -n creds 'remote refresh --all --watch 30'"
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  const ageMs = now - heartbeatMtimeMs;
  if (ageMs <= 2 * intervalMs) return undefined;
  const ageMin = Math.round(ageMs / 60_000);
  return (
    `[remote] creds supervisor heartbeat STALE (${ageMin}m old, > 2× the ${Math.round(
      intervalMs / 60_000,
    )}m interval) — the watcher likely stopped; remote Pods may be drifting to 401. ` +
    "Restart it: tmux new-window -n creds 'remote refresh --all --watch 30'"
  );
}

// ---------------------------------------------------------------------------
// claude OAuth expiry DETECTION → advisory ONLY (no auto-action this slice).
// ---------------------------------------------------------------------------

/** Within this window of `expiresAt` we warn the user to refresh claude locally. */
export const CLAUDE_EXPIRY_WARN_MS = 15 * 60_000; // 15 min

// TODO(slice 3, DEFERRED behind a dry-run flag — NOT this slice):
//  - newest-wins / pull-back: compare the POD's credential mtime/expiry with the
//    LOCAL one and only overwrite when local is genuinely newer (today we always
//    push local→pod on a 401; a pull-back that copies a fresher pod token back to
//    the laptop would hook in around `probeAndPushToolHealth` in soft-refresh.ts,
//    gated so it can NEVER overwrite a pod credential differently than today).
//  - claude AUTO-refresh: when `claudeTokenExpiry().expiringSoon`, spawn a local
//    `claude` to refresh the OAuth token (instead of only advising). It would hook
//    in where `localClaudeExpiryAdvisory` is emitted in index.ts. Out of scope:
//    spawning an interactive auth flow from a headless watcher needs its own
//    safety design (don't steal focus / loop on a failing refresh).

export type ClaudeExpiry = {
  /** Parsed `expiresAt` (ms epoch), or undefined when absent/unparseable. */
  readonly expiresAtMs: number | undefined;
  /** ms until expiry (negative when already expired); undefined when unknown. */
  readonly msUntilExpiry: number | undefined;
  /** true when expired OR within CLAUDE_EXPIRY_WARN_MS of expiry. */
  readonly expiringSoon: boolean;
  /** true when `now >= expiresAt`. */
  readonly expired: boolean;
};

/**
 * Parse a claude `.credentials.json` (already JSON.parsed object OR a raw
 * string) and report its OAuth-token expiry vs `now`. PURE. The token lives at
 * `claudeAiOauth.expiresAt` (ms epoch). A missing/invalid field yields all-
 * undefined / not-expiring (we never warn on what we can't read). We read ONLY
 * the numeric expiry — NEVER the token values. Exported for tests.
 */
export function claudeTokenExpiry(
  credential: unknown,
  now: number = Date.now(),
  warnMs: number = CLAUDE_EXPIRY_WARN_MS,
): ClaudeExpiry {
  let obj: unknown = credential;
  if (typeof credential === "string") {
    try {
      obj = JSON.parse(credential);
    } catch {
      obj = undefined;
    }
  }
  const expiresAtMs = readExpiresAt(obj);
  if (expiresAtMs === undefined) {
    return {
      expiresAtMs: undefined,
      msUntilExpiry: undefined,
      expiringSoon: false,
      expired: false,
    };
  }
  const msUntilExpiry = expiresAtMs - now;
  const expired = msUntilExpiry <= 0;
  const expiringSoon = msUntilExpiry <= warnMs;
  return { expiresAtMs, msUntilExpiry, expiringSoon, expired };
}

function readExpiresAt(obj: unknown): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const oauth = (obj as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const raw = (oauth as Record<string, unknown>).expiresAt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw;
}

/**
 * The loud, SECRET-FREE advisory string for a claude token that is expired or
 * about to expire. Returns undefined when not expiring soon. PURE. Used by the
 * watch loop's per-pass output AND the `ls` advisory. Exported for tests.
 */
export function claudeExpiryAdvisory(expiry: ClaudeExpiry): string | undefined {
  if (!expiry.expiringSoon) return undefined;
  if (expiry.expired) {
    return (
      "[remote] LOCAL claude OAuth token has EXPIRED — run `claude` locally to refresh it, " +
      "then the next supervisor pass will push the fresh token to your Pods."
    );
  }
  const mins = Math.max(0, Math.ceil((expiry.msUntilExpiry ?? 0) / 60_000));
  return (
    `[remote] LOCAL claude OAuth token expires in ${mins}m — run \`claude\` locally to refresh it ` +
    "so the supervisor can push the fresh token before your Pods 401."
  );
}
