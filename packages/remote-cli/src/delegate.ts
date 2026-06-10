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
