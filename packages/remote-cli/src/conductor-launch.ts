/**
 * WP10 — handler for h2a `conductor-launch-request` envelopes (PURE core).
 *
 * The h2a maintainer (a2a-cli, h2a 0.68.0) owns the EMIT side: when a workspace
 * has STALLED work AND no live conductor, h2a drops an envelope into `remote`'s
 * h2a inbox. h2a NEVER spawns — `remote` is the executor. This module is the
 * PURE decision core (parse + validate + select host + cooldown gate + task
 * builder); the side-effecting wiring (PATH detection, registry/h2a probes,
 * launch, inbox marking) lives in index.ts behind injectable seams.
 *
 * The on-disk envelope mirrors the standard h2a shape `{protocol, version, id,
 * type, actor, to, body, createdAt}` (h2a-jobs.ts / h2a-bridge.ts README). The
 * WP10 contract puts the payload on `body`:
 *   body.kind  = "message"
 *   body.topic = "conductor-launch-request"
 *   body.request = { kind, workspaceId, hostPref, stalled[], reason }
 * (we also tolerate the request fields spread directly onto `body` rather than
 * nested under `body.request`, since the maintainer's exact nesting is not yet
 * pinned — flagged for a2a-cli alignment).
 *
 * SECURITY: the conductor task is plain prose passed as a SINGLE argv token by
 * the caller (buildDelegateArgs → startJob); it is NEVER concatenated into a
 * `bash -lc` string. Nothing here shells out.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { DelegateType } from "./delegate.js";
import { defaultLocalH2aRoot } from "./h2a-bridge.js";

/** The contract topic the maintainer emits under. */
export const CONDUCTOR_LAUNCH_TOPIC = "conductor-launch-request";

/**
 * Default host preference order when the envelope omits one / lists only
 * unknown hosts. Mirrors the maintainer's documented default
 * (`['claude','codex','agy']`).
 */
export const DEFAULT_HOST_PREF: ReadonlyArray<DelegateType> = [
  "claude",
  "codex",
  "agy",
];

/** A stalled work item the conductor should pick up (best-effort fields). */
export type StalledItem = {
  id: string;
  title: string;
  reason?: string;
  since?: string;
};

/** The typed, validated payload of a `conductor-launch-request` envelope. */
export type ConductorLaunchRequest = {
  kind: "conductor-launch-request";
  /** Durable git-shared id: `ws:<hex>` (matchable via computeDurableWorkspaceId). */
  workspaceId: string;
  /** Ordered host preference (claude/codex/agy), normalized + filtered to known hosts. */
  hostPref: DelegateType[];
  stalled: StalledItem[];
  reason: string;
};

function isDelegateHost(value: unknown): value is DelegateType {
  return value === "claude" || value === "codex" || value === "agy";
}

/**
 * Normalize a raw hostPref: keep only known hosts, preserve the given order,
 * and fall back to the default order when nothing usable remains. Pure.
 */
function normalizeHostPref(raw: unknown): DelegateType[] {
  const hosts = Array.isArray(raw) ? raw.filter(isDelegateHost) : [];
  return hosts.length > 0 ? hosts : [...DEFAULT_HOST_PREF];
}

/** Keep only well-formed stalled items (id + title required). Pure. */
function normalizeStalled(raw: unknown): StalledItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StalledItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.title !== "string") continue;
    const item: StalledItem = { id: e.id, title: e.title };
    if (typeof e.reason === "string") item.reason = e.reason;
    if (typeof e.since === "string") item.since = e.since;
    out.push(item);
  }
  return out;
}

/**
 * Parse + validate an incoming `conductor-launch-request` envelope (a JSON
 * string OR an already-parsed object) into a typed `ConductorLaunchRequest`.
 * Returns undefined when the input is not a valid conductor-launch envelope:
 *  - not JSON / not an object,
 *  - body.kind !== "message" or body.topic !== "conductor-launch-request",
 *  - no workspaceId.
 * Tolerates the request nested under `body.request` OR spread onto `body`.
 * Pure (no fs / no clock), exported for tests.
 */
export function parseConductorLaunchEnvelope(
  input: string | unknown,
): ConductorLaunchRequest | undefined {
  let root: unknown;
  if (typeof input === "string") {
    try {
      root = JSON.parse(input);
    } catch {
      return undefined;
    }
  } else {
    root = input;
  }
  if (!root || typeof root !== "object") return undefined;
  const body = (root as { body?: unknown }).body;
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (b.kind !== "message" || b.topic !== CONDUCTOR_LAUNCH_TOPIC) return undefined;

  // The request is either nested (`body.request`) or spread onto `body`.
  const reqRaw =
    b.request && typeof b.request === "object"
      ? (b.request as Record<string, unknown>)
      : b;
  const workspaceId = reqRaw.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return undefined;
  }
  return {
    kind: "conductor-launch-request",
    workspaceId,
    hostPref: normalizeHostPref(reqRaw.hostPref),
    stalled: normalizeStalled(reqRaw.stalled),
    reason: typeof reqRaw.reason === "string" ? reqRaw.reason : "",
  };
}

/**
 * Pick the host to launch: the FIRST entry of `hostPref` that is in
 * `availableHosts` (the CLIs found on PATH). Honors the preference ORDER, not
 * the set's. Returns undefined when none of the preferred hosts is available.
 * Pure, exported for tests.
 */
export function selectHost(
  hostPref: ReadonlyArray<DelegateType>,
  availableHosts: ReadonlySet<DelegateType>,
): DelegateType | undefined {
  for (const host of hostPref) {
    if (availableHosts.has(host)) return host;
  }
  return undefined;
}

export type ShouldLaunchInput = {
  request: ConductorLaunchRequest;
  /** How many conductors we already know to be alive for this workspace (registry + h2a). */
  liveConductors: number;
  /** Epoch ms of the last launch for THIS workspace, or undefined when none. */
  lastLaunchAt: number | undefined;
  now: number;
  cooldownMs: number;
};

export type ShouldLaunchResult = { launch: boolean; reason: string };

/**
 * The launch gate, in priority order (each branch is mutually exclusive):
 *  1. a conductor is already alive → SKIP (idempotency, the whole point),
 *  2. there is no stalled work → SKIP (nothing to conduct),
 *  3. a launch happened within the cooldown window → SKIP (watch-loop guard),
 *  4. otherwise → LAUNCH.
 * The live-conductor check wins over the cooldown so an idempotent skip is
 * always reported as such. Pure (clock injected via `now`), exported for tests.
 */
export function shouldLaunch(input: ShouldLaunchInput): ShouldLaunchResult {
  if (input.liveConductors > 0) {
    return {
      launch: false,
      reason: `a conductor is already alive for ${input.request.workspaceId} (${input.liveConductors}) — idempotent skip`,
    };
  }
  if (input.request.stalled.length === 0) {
    return {
      launch: false,
      reason: "no stalled work to conduct — nothing to launch",
    };
  }
  if (
    input.lastLaunchAt !== undefined &&
    input.now - input.lastLaunchAt < input.cooldownMs
  ) {
    const mins = Math.ceil(
      (input.cooldownMs - (input.now - input.lastLaunchAt)) / 60_000,
    );
    return {
      launch: false,
      reason: `within cooldown for ${input.request.workspaceId} (~${mins} min left)`,
    };
  }
  return {
    launch: true,
    reason: `stalled work and no live conductor for ${input.request.workspaceId}`,
  };
}

/**
 * The task prompt for the delegated conductor. It instructs the agent to CLAIM
 * the conductor role at boot (`h2a conductor claim`, if available) then conduct
 * the stalled items. Returned as plain prose — the caller passes it as a SINGLE
 * argv token (buildDelegateArgs → startJob); it is NEVER shell-concatenated.
 * Pure, exported for tests.
 */
export function buildConductorTask(request: ConductorLaunchRequest): string {
  const items =
    request.stalled.length > 0
      ? request.stalled
          .map((s) => {
            const why = s.reason ? ` — ${s.reason}` : "";
            return `  - [${s.id}] ${s.title}${why}`;
          })
          .join("\n")
      : "  (no specific items listed; discover the stalled work yourself)";
  return [
    `You are the CONDUCTOR for workspace ${request.workspaceId}.`,
    "",
    "BOOT STEP (do this FIRST, before anything else):",
    "  Claim the conductor role so peers know you own it. If the `h2a` CLI is",
    "  available, run: h2a conductor claim",
    "  (If `h2a` is not installed, proceed without claiming — best-effort.)",
    "",
    `Why you were launched: ${request.reason || "stalled work with no live conductor"}.`,
    "",
    "Stalled work to conduct:",
    items,
    "",
    "Drive these items to completion: unblock, delegate, and follow up. When the",
    "backlog is drained, release the conductor role (`h2a conductor release` if",
    "available) and end your session.",
  ].join("\n");
}

/**
 * Normalize the root-commit set into the canonical string a2a-cli/track hash:
 * ALL root commits (`git rev-list --max-parents=0 HEAD`), trimmed, de-duped,
 * sorted ascending, joined by ",". A mono-root repo collapses to its single
 * SHA. Invariant across clone / fork / path / machine (unlike a remote url).
 * Pure, exported for tests.
 */
export function normalizeRootCommits(shas: ReadonlyArray<string>): string {
  return [...new Set(shas.map((s) => s.trim()).filter((s) => s.length > 0))]
    .sort()
    .join(",");
}

/**
 * Durable, git-shared workspace id — byte-identical to track + h2a 0.68's
 * `durableWorkspaceId`:
 *
 *   workspaceId = "ws:" + sha256hex( rootCommitSHA + "\n" + worktreeRelPath )
 *
 * where `rootCommitSHA` is {@link normalizeRootCommits}' output and
 * `worktreeRelPath` is "" for the primary worktree, else the basename of
 * `git rev-parse --git-dir` (the `.git/worktrees/<name>` dir) for a linked
 * worktree. Pinned vectors (shared with track): ("abc","") →
 * ws:edeaaff3… ; ("abc","my-feature") → ws:81a25e53…. Pure, exported for tests.
 */
export function computeDurableWorkspaceId(
  rootCommitSHA: string,
  worktreeRelPath: string,
): string {
  const hex = createHash("sha256")
    .update(`${rootCommitSHA}\n${worktreeRelPath}`, "utf8")
    .digest("hex");
  return `ws:${hex}`;
}

// ---------------------------------------------------------------------------
// Side-effecting seams (PATH detection, h2a probe, inbox read + processed
// marking, last-launch tracking). Each takes an injectable seam so index.ts
// stays thin and tests never shell out / touch the real ~/h2a-workspace.
// ---------------------------------------------------------------------------

/**
 * Which delegate hosts (claude/codex/agy) are resolvable on PATH. The `which`
 * seam is injectable; the default uses a login shell `command -v` (same probe
 * as tmux.ts commandAvailable / delegate.ts defaultWhich), so it sees the same
 * binaries the tmux windows would. Best-effort: a failing probe = not present.
 */
export function detectAvailableHosts(
  which: (bin: string) => boolean = defaultHostAvailable,
): Set<DelegateType> {
  const out = new Set<DelegateType>();
  for (const host of ["claude", "codex", "agy"] as const) {
    if (which(host)) out.add(host);
  }
  return out;
}

function defaultHostAvailable(bin: string): boolean {
  try {
    return (
      spawnSync("bash", ["-lc", `command -v -- ${bin}`], { stdio: "ignore" })
        .status === 0
    );
  } catch {
    return false;
  }
}

/**
 * Thin seam over a live `h2a` call: returns the raw stdout, or undefined when
 * the `h2a` binary is missing / errors (GRACEFUL DEGRADE — the caller treats an
 * undefined result as "can't tell from h2a", falling back to our own registry).
 * The runner is injectable so tests never shell out. Best-effort, never throws.
 */
export type H2aRunner = (args: ReadonlyArray<string>) => string | undefined;

export function defaultH2aRunner(
  args: ReadonlyArray<string>,
): string | undefined {
  try {
    const probe = spawnSync("bash", ["-lc", "command -v -- h2a"], {
      stdio: "ignore",
    });
    if (probe.status !== 0) return undefined; // h2a not installed → degrade
    const r = spawnSync("h2a", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0) return undefined;
    return r.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Does h2a itself report a live conductor for `workspaceId`? Best-effort over
 * `h2a discover` (whatever shape it prints — we only look for the durable id +
 * a "conductor" mention near it). Returns:
 *  - true  → h2a sees a conductor (definitely skip),
 *  - false → h2a ran and did NOT mention one,
 *  - undefined → h2a unavailable / unparseable (caller relies on the registry).
 * Conservative substring match (the maintainer's discover output is not pinned
 * — flagged for a2a-cli alignment). The runner is injectable.
 */
export function h2aReportsLiveConductor(
  workspaceId: string,
  run: H2aRunner = defaultH2aRunner,
): boolean | undefined {
  const out = run(["discover"]);
  if (out === undefined) return undefined;
  // A line mentioning both the workspace id and "conductor" is the signal.
  for (const line of out.split("\n")) {
    if (line.includes(workspaceId) && /conductor/i.test(line)) return true;
  }
  // h2a ran but said nothing about a conductor for this workspace.
  return false;
}

// --- Inbox: read launch envelopes + idempotent processed-marking ------------

export type LaunchEnvelopeFile = {
  /** Absolute path of the envelope file. */
  path: string;
  /** mtime (epoch ms) — used to pick the FRESHEST unprocessed envelope. */
  mtimeMs: number;
  request: ConductorLaunchRequest;
};

/**
 * Read every `conductor-launch-request` envelope under `<localRoot>/inbox/**`
 * (one dir level deep, the h2a layout — same as h2a-jobs.readInboxEnvelopes),
 * parsed + validated. Skips already-processed ones (a sibling `.processed`
 * stamp, see markProcessed). Missing store → []. Never throws on a bad file.
 * The fs is isolated here so the parsing above stays pure.
 */
export function readLaunchEnvelopes(
  localRoot: string = defaultLocalH2aRoot(),
): LaunchEnvelopeFile[] {
  const inbox = join(localRoot, "inbox");
  if (!existsSync(inbox)) return [];
  const out: LaunchEnvelopeFile[] = [];
  for (const dir of readdirSync(inbox, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(inbox, dir.name);
    for (const f of readdirSync(dirPath, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const path = join(dirPath, f.name);
      if (existsSync(processedStampPath(path))) continue; // already handled
      let raw: string;
      let mtimeMs: number;
      try {
        raw = readFileSync(path, "utf8");
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const request = parseConductorLaunchEnvelope(raw);
      if (request) out.push({ path, mtimeMs, request });
    }
  }
  return out;
}

/** The freshest (highest mtime) unprocessed launch envelope, or undefined. Pure. */
export function freshestLaunchEnvelope(
  envelopes: ReadonlyArray<LaunchEnvelopeFile>,
): LaunchEnvelopeFile | undefined {
  let best: LaunchEnvelopeFile | undefined;
  for (const e of envelopes) {
    if (!best || e.mtimeMs > best.mtimeMs) best = e;
  }
  return best;
}

/** Sibling stamp marking an envelope as processed (idempotency, never re-acted). */
function processedStampPath(envelopePath: string): string {
  return `${envelopePath}.processed`;
}

/**
 * Idempotently mark an envelope processed by dropping a sibling `.processed`
 * stamp next to it (we never DELETE the envelope — the bridge/h2a own cleanup,
 * exactly like dropEnvelope's non-destructive contract). Best-effort: returns
 * false on any fs error. `note` is a short human reason (dry-run vs launched).
 */
export function markLaunchEnvelopeProcessed(
  envelopePath: string,
  note: string,
  nowMs: number = Date.now(),
): boolean {
  try {
    writeFileSync(
      processedStampPath(envelopePath),
      `${JSON.stringify({ processedAt: new Date(nowMs).toISOString(), note })}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

// --- Per-workspace last-launch tracking (cooldown) --------------------------

type LaunchLog = { version: 1; lastLaunchAt: Record<string, number> };

/** Path of the per-workspace last-launch log under the h2a store. */
function launchLogPath(localRoot: string): string {
  return join(localRoot, "conductor-launch-log.json");
}

/** Read the last-launch epoch ms for `workspaceId`, or undefined. Best-effort. */
export function readLastLaunchAt(
  workspaceId: string,
  localRoot: string = defaultLocalH2aRoot(),
): number | undefined {
  try {
    const log = JSON.parse(
      readFileSync(launchLogPath(localRoot), "utf8"),
    ) as Partial<LaunchLog>;
    const at = log.lastLaunchAt?.[workspaceId];
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record `nowMs` as the last launch for `workspaceId` (so a watch loop honors
 * the per-workspace cooldown). Best-effort: returns false on any fs error.
 * Atomic-ish (tmp + rename) like the registry.
 */
export function recordLaunchAt(
  workspaceId: string,
  nowMs: number = Date.now(),
  localRoot: string = defaultLocalH2aRoot(),
): boolean {
  try {
    const path = launchLogPath(localRoot);
    let log: LaunchLog = { version: 1, lastLaunchAt: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LaunchLog>;
      if (parsed.lastLaunchAt && typeof parsed.lastLaunchAt === "object") {
        log = { version: 1, lastLaunchAt: { ...parsed.lastLaunchAt } };
      }
    } catch {
      // missing / corrupt → start fresh
    }
    log.lastLaunchAt[workspaceId] = nowMs;
    mkdirSync(localRoot, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
