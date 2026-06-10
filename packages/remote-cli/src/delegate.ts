/**
 * `remote delegate <type> "<task>"` — P1 of cross-type agent delegation.
 *
 * Spawns a LIVE, INTERACTIVE agent (claude / codex / agy) in a DETACHED tmux
 * session, PRIMED with the task, with the h2a MCP server in a side window (the
 * existing `remote run --h2a` path) so the parent/master feedback loop works.
 * Returns a job id (slug). The job is enrolled in the SAME registry as sessions
 * with `role: "job"` (no second jobs.json), so `listLive` + the liveness guards
 * + the atomic write are reused as-is.
 *
 * Isolation: by default, if the cwd is a git repo, each job runs in its OWN git
 * worktree under `<cwd>/.remote/jobs/<jobId>/wt` — the single-writer guard only
 * protects the conversation `.jsonl`, not the file tree, so concurrent jobs in
 * the shared cwd would clobber each other. `--cwd` overrides; a non-repo cwd is
 * used as-is.
 *
 * `--headless` is the run-once-exit variant (NOT drop-to-shell): it runs
 * `claude -p` / `codex exec`, redirects stdout+stderr to `<dir>/output.log`,
 * writes `<dir>/result.json {state,exitCode}`, then ENDS the tmux session.
 *
 * SECURITY: the task is passed as a SINGLE argv token — never concatenated into
 * a shell string. The jobId / `--name` pass `assertSafeName` before becoming a
 * tmux slug, a directory, or a filename.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { JobState, RegistryEntry, RegistryTool } from "./registry.js";
import { humanAge } from "./migrate-candidates.js";

export type DelegateType = RegistryTool; // claude | codex | agy

const DELEGATE_BIN: Readonly<Record<DelegateType, string>> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
};

/** Job id / `--name`: becomes a tmux slug, a dir, a filename — keep it tame. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `invalid job name "${name}" (allowed: letters, digits, "_", "-")`,
    );
  }
}

export function isDelegateType(value: string): value is DelegateType {
  return value === "claude" || value === "codex" || value === "agy";
}

/**
 * The EXACT argv for the agent binary, by type and mode. Pure, exported for
 * tests. The task is ALWAYS a single trailing token (no shell concat):
 *  - interactive: the agent starts live, primed with the task as a positional
 *    initial prompt (claude/codex/agy all accept a bare positional prompt);
 *  - headless: a run-once-exit print mode — claude `-p`, codex `exec`. agy has
 *    no confirmed headless mode (design R3), so headless agy throws.
 *
 * Returns `{ command, args }` where args ends with the task token.
 */
export function buildDelegateArgs(
  type: DelegateType,
  task: string,
  headless: boolean,
): { command: string; args: string[] } {
  const command = DELEGATE_BIN[type];
  if (!headless) {
    // Interactive + initial prompt — task is the last argv token.
    return { command, args: [task] };
  }
  switch (type) {
    case "claude":
      return { command, args: ["-p", task] };
    case "codex":
      return { command, args: ["exec", task] };
    case "agy":
      throw new Error(
        "agy has no confirmed headless mode — run it interactively (drop --headless)",
      );
  }
}

/**
 * P2 — REMOTE delegation. Map a (type, task) to the control-plane session body
 * for a delegated agent running in a Pod. The agent CLI is the session PROFILE
 * (profiles claude/codex/agy launch the matching binary on the Pod), and the
 * task rides the ALREADY-SAFE argv channel `startupArgs` — exactly the args that
 * follow the binary, which the session-agent reads from `SESSION_STARTUP_ARGS`
 * (a JSON array, never a `bash -lc` string). We reuse `buildDelegateArgs` and
 * DROP its `command` (the profile already provides the binary): `args` is what
 * trails it (the bare task token interactive, `-p <task>` / `exec <task>`
 * headless). Pure, exported for tests.
 *
 * SECURITY: the task stays a single argv element through `startupArgs` → JSON →
 * the agent's argv; it is NEVER concatenated into a shell string.
 */
export function buildRemoteDelegate(
  type: DelegateType,
  task: string,
  headless: boolean,
): { profile: DelegateType; startupArgs: string[] } {
  const { args } = buildDelegateArgs(type, task, headless);
  return { profile: type, startupArgs: args };
}

// ---------------------------------------------------------------------------
// P4 — concurrency cap + queue + spawn-depth (pure, conductor-driving)
// ---------------------------------------------------------------------------

/**
 * Default concurrency cap (Hermes `max_concurrent_children`), applied to BOTH
 * local AND remote jobs: the shared RWX volume is mounted RW across all nodes
 * (subPath per job — no CSI packing limit, design F3 correction), so remote is
 * not sequential. A new `delegate` beyond `running` jobs is enrolled `pending`.
 */
export const DEFAULT_MAX_CONCURRENT = 16;

/** Default / min / max spawn depth (Hermes `max_spawn_depth`, clamp 1–3). */
export const DEFAULT_MAX_DEPTH = 1;
export const MIN_MAX_DEPTH = 1;
export const MAX_MAX_DEPTH = 3;

/** The env channel carrying the REMAINING delegation depth into a job's agent. */
export const DEPTH_ENV = "REMOTE_DELEGATE_DEPTH";

/**
 * Clamp a requested `--max-depth` into [1, 3] (à la Hermes). A missing /
 * non-finite value falls back to the default (1). Pure, exported for tests.
 */
export function clampDepth(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_DEPTH;
  }
  const n = Math.trunc(requested);
  if (n < MIN_MAX_DEPTH) return MIN_MAX_DEPTH;
  if (n > MAX_MAX_DEPTH) return MAX_MAX_DEPTH;
  return n;
}

/**
 * The depth a job INHERITS from its parent, read off `REMOTE_DELEGATE_DEPTH`
 * (decremented at each launch). When a `delegate` runs OUTSIDE a job (no env),
 * the requested `--max-depth` is the budget. When it runs INSIDE a job, the
 * inherited budget wins (a job cannot grant itself more than it was given).
 * Pure, exported for tests; `env` is injectable.
 *
 * Returns the budget the CURRENT `delegate` may spend:
 *  - no env (top-level): clamp(requestedMaxDepth).
 *  - env present: the inherited value (already a remaining budget), clamped
 *    to [0, 3] — 0 means "this job may not delegate further".
 */
export function inheritedDepthBudget(
  requestedMaxDepth: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEPTH_ENV];
  if (raw === undefined) return clampDepth(requestedMaxDepth);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return clampDepth(requestedMaxDepth);
  if (parsed < 0) return 0;
  if (parsed > MAX_MAX_DEPTH) return MAX_MAX_DEPTH;
  return parsed;
}

/**
 * May a `delegate` proceed given its current depth budget? A budget of 0 means
 * the calling job has exhausted its delegation depth and must REFUSE. Pure.
 */
export function canDelegateAtDepth(budget: number): boolean {
  return budget > 0;
}

/**
 * The depth value to PROPAGATE to a freshly launched job: the parent's budget
 * minus one (never below 0), so the child knows how much further it may go.
 * Returned as the string the env channel carries. Pure, exported for tests.
 */
export function childDepthEnvValue(parentBudget: number): string {
  return String(Math.max(0, parentBudget - 1));
}

/**
 * Decide which `pending` jobs to START this pass, given the cap. Pure, the heart
 * of the queue: count jobs currently occupying a slot (`running`), and admit
 * `pending` jobs (oldest first — FIFO by `enrolledAt`) until `running` reaches
 * the cap. Terminal jobs (done/failed) free their slot. Returns the ids to
 * start, in admission order. Exported for tests.
 *
 * `cap <= 0` admits nothing (a degenerate config never starts work).
 */
export function planNextStarts(
  jobs: ReadonlyArray<Pick<RegistryEntry, "id" | "role" | "jobState" | "enrolledAt">>,
  cap: number,
): string[] {
  if (cap <= 0) return [];
  const onlyJobs = jobs.filter((j) => j.role === "job");
  const running = onlyJobs.filter((j) => (j.jobState ?? "pending") === "running").length;
  let free = cap - running;
  if (free <= 0) return [];
  const pending = onlyJobs
    .filter((j) => (j.jobState ?? "pending") === "pending")
    .slice()
    .sort((a, b) => Date.parse(a.enrolledAt) - Date.parse(b.enrolledAt));
  const out: string[] = [];
  for (const j of pending) {
    if (free <= 0) break;
    out.push(j.id);
    free -= 1;
  }
  return out;
}

/**
 * Is there room to start a job RIGHT NOW (used by `delegate` to decide launch vs
 * enqueue)? True when `running < cap`. Pure, exported for tests.
 */
export function hasFreeSlot(
  jobs: ReadonlyArray<Pick<RegistryEntry, "role" | "jobState">>,
  cap: number,
): boolean {
  if (cap <= 0) return false;
  const running = jobs.filter(
    (j) => j.role === "job" && (j.jobState ?? "pending") === "running",
  ).length;
  return running < cap;
}

// ---------------------------------------------------------------------------
// P4 — track mirror (job graph = backlog). PURE arg derivation; best-effort.
// ---------------------------------------------------------------------------

/**
 * The `track item new` argv that mirrors a delegated job as a child item under
 * the workpackage `wpId`. PURE (no spawn): the caller resolves the track binary
 * (realpath) and runs it best-effort. `--role item`, parented under the WP, with
 * a stable title derived from the job. Exported for tests.
 *
 * SECURITY: jobId is assertSafeName-checked at delegate time; wpId/task ride
 * structured argv (never a shell string).
 */
export function trackItemNewArgs(wpId: string, job: { id: string; task?: string }): string[] {
  const title = job.task && job.task.length > 0 ? job.task : `job ${job.id}`;
  return [
    "item",
    "new",
    "--parent",
    wpId,
    "--role",
    "item",
    "--title",
    title,
    "--ref",
    `job:${job.id}`,
  ];
}

/**
 * The `track item realize` argv to close the mirror item when a job reaches a
 * terminal state. We address the item by the same `job:<id>` ref we created it
 * with. PURE; the caller runs it best-effort. Exported for tests.
 */
export function trackItemRealizeArgs(job: { id: string }): string[] {
  return ["item", "realize", "--ref", `job:${job.id}`];
}

export type TrackRunner = (args: ReadonlyArray<string>) => { status: number | null };

/**
 * Resolve the `track` binary to its REALPATH (some track versions have an
 * entrypoint guard that breaks through the npm-global bin symlink — same note as
 * config.ts PluginMcp). Returns `node <realpath>` argv, or undefined when track
 * is not installed. Best-effort, exported for tests (the `which`+realpath are
 * injectable).
 */
export function resolveTrackBin(
  which: (bin: string) => string | undefined = defaultWhich,
  realpath: (p: string) => string = (p) => p,
): { command: string; prefix: string[] } | undefined {
  const found = which("track");
  if (!found) return undefined;
  try {
    return { command: "node", prefix: [realpath(found)] };
  } catch {
    return { command: found, prefix: [] };
  }
}

function defaultWhich(bin: string): string | undefined {
  const r = spawnSync("sh", ["-lc", `command -v ${bin}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out.length > 0 ? out : undefined;
}

/**
 * Best-effort track-mirror call: resolve `track`, run `track <args>` in `cwd`,
 * swallow ANY failure (track absent/erroring must NEVER couple delivery to
 * track). Returns whether it ran. The runner is injectable for tests.
 */
export function runTrackMirror(
  args: ReadonlyArray<string>,
  cwd: string,
  run?: TrackRunner,
): boolean {
  try {
    if (run) {
      run(args);
      return true;
    }
    const bin = resolveTrackBin();
    if (!bin) return false;
    spawnSync(bin.command, [...bin.prefix, ...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Per-job directory under the ORIGIN cwd (where worktree + logs live). */
export function jobDir(originCwd: string, jobId: string): string {
  return join(originCwd, ".remote", "jobs", jobId);
}

export type JobResult = { state: "done" | "failed"; exitCode: number };

/**
 * The terminal result a HEADLESS job wrote to `result.json` (run-once-exit), or
 * undefined when absent / unreadable. Lets supervision reconcile a finished
 * headless job (whose tmux session has ended) to its REAL state instead of the
 * default "session-gone → failed". Pure-ish (reads one file), injectable read.
 */
export function readJobResult(
  originCwd: string,
  jobId: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): JobResult | undefined {
  const path = join(jobDir(originCwd, jobId), "result.json");
  try {
    const parsed = JSON.parse(read(path)) as Partial<JobResult>;
    if (
      (parsed.state === "done" || parsed.state === "failed") &&
      typeof parsed.exitCode === "number"
    ) {
      return { state: parsed.state, exitCode: parsed.exitCode };
    }
  } catch {
    // missing / unreadable / malformed → no result yet
  }
  return undefined;
}

export type GitProbe = (cwd: string) => boolean;
export type Runner = (
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
) => { status: number | null };

function defaultIsGitRepo(cwd: string): boolean {
  if (!existsSync(cwd)) return false;
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

function defaultRunGit(
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
): { status: number | null } {
  const r = spawnSync(cmd, [...args], { cwd, stdio: "inherit" });
  return { status: r.status };
}

export type ResolveCwdOpts = {
  /** Explicit cwd override (`--cwd`): used as-is, no worktree. */
  explicitCwd?: string;
  isGitRepo?: GitProbe;
  runGit?: Runner;
  mkdir?: (p: string) => void;
};

export type ResolvedCwd = {
  /** The directory the agent actually runs in. */
  runCwd: string;
  /** True when a dedicated git worktree was created for file-tree isolation. */
  isolated: boolean;
};

/**
 * Decide WHERE the job runs and create isolation if warranted:
 *  - `--cwd <path>` → that path, as-is (caller owns isolation).
 *  - else if the origin cwd is a git repo → a dedicated worktree at
 *    `<originCwd>/.remote/jobs/<jobId>/wt` (so concurrent jobs never clobber the
 *    working tree; the single-writer guard only protects the `.jsonl`).
 *  - else → the origin cwd, as-is (non-repo: nothing to isolate cheaply).
 *
 * Throws if the worktree creation fails (we must NOT silently run in the shared
 * cwd, which would defeat isolation).
 */
export function resolveJobCwd(
  originCwd: string,
  jobId: string,
  opts: ResolveCwdOpts = {},
): ResolvedCwd {
  if (opts.explicitCwd !== undefined) {
    return { runCwd: opts.explicitCwd, isolated: false };
  }
  const isRepo = (opts.isGitRepo ?? defaultIsGitRepo)(originCwd);
  if (!isRepo) return { runCwd: originCwd, isolated: false };

  const dir = jobDir(originCwd, jobId);
  const wt = join(dir, "wt");
  (opts.mkdir ?? ((p) => mkdirSync(p, { recursive: true })))(dir);
  const run = opts.runGit ?? defaultRunGit;
  // Detached worktree on current HEAD — a fresh, independent file tree.
  const r = run("git", ["worktree", "add", "--detach", wt, "HEAD"], originCwd);
  if (r.status !== 0) {
    throw new Error(
      `git worktree add failed (exit ${r.status ?? "?"}) for job ${jobId} — ` +
        `pass --cwd to run in an explicit directory instead`,
    );
  }
  return { runCwd: wt, isolated: true };
}

// ---------------------------------------------------------------------------
// Supervision — `remote jobs ls` (pure rendering)
// ---------------------------------------------------------------------------

export type JobRow = {
  id: string;
  type: DelegateType;
  state: JobState;
  age: string;
  cwd: string;
};

/**
 * The DISPLAY state of a job, reconciling its persisted `jobState` with live
 * liveness: a job still marked `running`/`pending` whose tmux session is gone
 * has crashed/finished → show `failed` (P1 has no headless-success poll in the
 * pure layer; the headless result.json is surfaced by `jobs status`). A job
 * already in a terminal state keeps it. Pure, exported for tests.
 */
export function reconcileJobState(
  entry: Pick<RegistryEntry, "jobState" | "endedAt">,
  live: boolean,
): JobState {
  const persisted = entry.jobState ?? "pending";
  if (persisted === "done" || persisted === "failed") return persisted;
  if (entry.endedAt) return "failed";
  if (!live) return "failed";
  return persisted;
}

/**
 * P2 — CLUSTER reconciliation for REMOTE jobs (`kind:"remote"`). The registry
 * reports a remote entry as `isLive` ALWAYS (it can't probe the cluster —
 * registry.ts), so a delegated Pod that died/finished would stay "running"
 * forever. Given the set of session ids the control-plane still lists
 * (`listRemoteSessions`), this decides the transitions to apply: a remote job
 * still in a non-terminal state whose `remoteId` is NOT in the live set has
 * ended → `done` when it left a `result.json` (success/known exit), else
 * `failed`. Jobs whose Pod is still listed, or already terminal, are untouched.
 * Pure (the result read is injected), exported for tests.
 */
export function reconcileRemoteJobs(
  jobs: ReadonlyArray<RegistryEntry>,
  liveRemoteIds: ReadonlySet<string>,
  readResult: (job: RegistryEntry) => JobResult | undefined,
): Array<{ id: string; to: JobState }> {
  const out: Array<{ id: string; to: JobState }> = [];
  for (const job of jobs) {
    if (job.kind !== "remote" || job.role !== "job") continue;
    const state = job.jobState ?? "pending";
    if (state === "done" || state === "failed") continue;
    // The Pod is still listed by the control-plane → leave the job alone.
    if (job.remoteId !== undefined && liveRemoteIds.has(job.remoteId)) continue;
    const result = readResult(job);
    out.push({ id: job.id, to: result?.state ?? "failed" });
  }
  return out;
}

/**
 * Build `jobs ls` rows from job entries + an injectable liveness probe. Pure,
 * exported for tests. `nowMs` makes the age deterministic.
 */
export function buildJobRows(
  jobs: ReadonlyArray<RegistryEntry>,
  isJobLive: (e: RegistryEntry) => boolean,
  nowMs: number = Date.now(),
): JobRow[] {
  return jobs.map((e) => ({
    id: e.id,
    type: e.tool,
    state: reconcileJobState(e, isJobLive(e)),
    age: humanAge(Date.parse(e.enrolledAt), nowMs),
    cwd: e.cwd,
  }));
}

/** Render `jobs ls` rows as an aligned plain-text table. Pure. */
export function renderJobsTable(rows: ReadonlyArray<JobRow>): string {
  if (rows.length === 0) return "(no delegated jobs)";
  const cols: Array<[keyof JobRow, string]> = [
    ["id", "ID"],
    ["type", "TYPE"],
    ["state", "STATE"],
    ["age", "AGE"],
    ["cwd", "CWD"],
  ];
  const widths = cols.map(([key, title]) =>
    Math.max(title.length, ...rows.map((r) => String(r[key]).length)),
  );
  const line = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(cols.map(([, t]) => t))];
  for (const r of rows) out.push(line(cols.map(([k]) => String(r[k]))));
  return out.join("\n");
}
