import { describe, expect, it, vi } from "vitest";

import {
  assertSafeName,
  buildDelegateArgs,
  buildJobRows,
  buildRemoteDelegate,
  canDelegateAtDepth,
  childDepthEnvValue,
  clampDepth,
  clampRemoteDepthBudget,
  conductorAdvisory,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_DEPTH,
  hasFreeSlot,
  inheritedDepthBudget,
  isDelegateType,
  jobDir,
  planNextStarts,
  readJobResult,
  reconcileJobState,
  reconcileRemoteJobs,
  renderJobsTable,
  resolveJobCwd,
  resolveTrackBin,
  runTrackMirror,
  sweepStaleJobs,
  trackItemNewArgs,
  trackItemRealizeArgs,
} from "./delegate.js";
import type { RegistryEntry } from "./registry.js";

describe("buildDelegateArgs (pure, task is a single argv token)", () => {
  it("interactive: bare positional prompt per type", () => {
    expect(buildDelegateArgs("claude", "do X", false)).toEqual({
      command: "claude",
      args: ["do X"],
    });
    expect(buildDelegateArgs("codex", "do X", false)).toEqual({
      command: "codex",
      args: ["do X"],
    });
    expect(buildDelegateArgs("agy", "do X", false)).toEqual({
      command: "agy",
      args: ["do X"],
    });
  });

  it("headless: claude -p / codex exec, task still a single token", () => {
    expect(buildDelegateArgs("claude", "ship it", true)).toEqual({
      command: "claude",
      args: ["-p", "ship it"],
    });
    expect(buildDelegateArgs("codex", "ship it", true)).toEqual({
      command: "codex",
      args: ["exec", "ship it"],
    });
  });

  it("a task with shell metacharacters stays ONE argv element (no injection)", () => {
    const evil = '"; rm -rf / #';
    const { args } = buildDelegateArgs("claude", evil, false);
    expect(args).toEqual([evil]);
    expect(args).toHaveLength(1);
  });

  it("headless agy is rejected (no confirmed headless mode)", () => {
    expect(() => buildDelegateArgs("agy", "x", true)).toThrow(/headless/);
  });
});

describe("assertSafeName / isDelegateType (name + type guards)", () => {
  it("accepts letters/digits/_/-", () => {
    expect(() => assertSafeName("claude-job_1")).not.toThrow();
  });

  it("rejects path/shell-dangerous names", () => {
    for (const bad of ["../etc", "a b", "a/b", "a;b", "a$b", ""]) {
      expect(() => assertSafeName(bad)).toThrow(/invalid job name/);
    }
  });

  it("isDelegateType narrows to claude|codex|agy", () => {
    expect(isDelegateType("claude")).toBe(true);
    expect(isDelegateType("codex")).toBe(true);
    expect(isDelegateType("agy")).toBe(true);
    expect(isDelegateType("opencode")).toBe(false);
    expect(isDelegateType("shell")).toBe(false);
  });
});

describe("resolveJobCwd (file-tree isolation, git mocked)", () => {
  it("--cwd is used as-is, no worktree, no git calls", () => {
    const runGit = vi.fn();
    const r = resolveJobCwd("/repo", "job1", {
      explicitCwd: "/elsewhere",
      runGit,
    });
    expect(r).toEqual({ runCwd: "/elsewhere", isolated: false });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("a non-repo cwd runs as-is (no isolation)", () => {
    const runGit = vi.fn();
    const r = resolveJobCwd("/plain", "job1", {
      isGitRepo: () => false,
      runGit,
    });
    expect(r).toEqual({ runCwd: "/plain", isolated: false });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("a repo cwd gets a dedicated worktree under .remote/jobs/<id>/wt", () => {
    const mkdir = vi.fn();
    const runGit = vi.fn().mockReturnValue({ status: 0 });
    const r = resolveJobCwd("/repo", "job1", {
      isGitRepo: () => true,
      runGit,
      mkdir,
    });
    const wt = jobDir("/repo", "job1") + "/wt";
    expect(r).toEqual({ runCwd: wt, isolated: true });
    expect(mkdir).toHaveBeenCalledWith(jobDir("/repo", "job1"));
    expect(runGit).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "--detach", wt, "HEAD"],
      "/repo",
    );
  });

  it("a failed worktree add throws (never silently shares the cwd)", () => {
    expect(() =>
      resolveJobCwd("/repo", "job1", {
        isGitRepo: () => true,
        runGit: () => ({ status: 1 }),
        mkdir: () => {},
      }),
    ).toThrow(/git worktree add failed/);
  });
});

describe("readJobResult (headless run-once-exit result.json)", () => {
  it("parses a well-formed result with injectable read", () => {
    const read = () => '{"state":"done","exitCode":0}';
    expect(readJobResult("/repo", "j", read)).toEqual({
      state: "done",
      exitCode: 0,
    });
  });

  it("returns undefined for a missing / malformed result", () => {
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(readJobResult("/repo", "j", missing)).toBeUndefined();
    expect(readJobResult("/repo", "j", () => "not json")).toBeUndefined();
    expect(
      readJobResult("/repo", "j", () => '{"state":"weird","exitCode":0}'),
    ).toBeUndefined();
  });
});

describe("reconcileJobState (display state vs liveness)", () => {
  it("terminal states are kept regardless of liveness", () => {
    expect(reconcileJobState({ jobState: "done" }, false)).toBe("done");
    expect(reconcileJobState({ jobState: "failed" }, true)).toBe("failed");
  });

  it("a running job whose session is gone shows failed", () => {
    expect(reconcileJobState({ jobState: "running" }, false)).toBe("failed");
  });

  it("a running, live job stays running", () => {
    expect(reconcileJobState({ jobState: "running" }, true)).toBe("running");
  });

  it("an endedAt stamp forces failed even if probed live", () => {
    expect(
      reconcileJobState({ jobState: "running", endedAt: "2026-01-01" }, true),
    ).toBe("failed");
  });
});

function jobEntry(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: "j",
    tool: "claude",
    kind: "local-tmux",
    cwd: "/repo/.remote/jobs/j/wt",
    enrolledAt: new Date(Date.now() - 5000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    source: "run",
    role: "job",
    jobState: "running",
    ...over,
  };
}

describe("buildJobRows / renderJobsTable (jobs ls rendering)", () => {
  it("maps entries to rows with reconciled state + deterministic age", () => {
    const now = Date.now();
    const jobs = [
      jobEntry({ id: "a", tool: "claude", enrolledAt: new Date(now - 1000).toISOString() }),
      jobEntry({ id: "b", tool: "codex", jobState: "running" }),
    ];
    const rows = buildJobRows(jobs, (e) => e.id === "a", now);
    expect(rows).toEqual([
      { id: "a", type: "claude", state: "running", age: "1s", cwd: jobs[0]!.cwd },
      { id: "b", type: "codex", state: "failed", age: expect.any(String), cwd: jobs[1]!.cwd },
    ]);
  });

  it("renders an aligned table with a header", () => {
    const rows = buildJobRows([jobEntry({ id: "abc" })], () => true, Date.now());
    const table = renderJobsTable(rows);
    expect(table.split("\n")[0]).toMatch(/^ID\s+TYPE\s+STATE\s+AGE\s+CWD$/);
    expect(table).toContain("abc");
  });

  it("empty job list renders a placeholder", () => {
    expect(renderJobsTable([])).toBe("(no delegated jobs)");
  });
});

// ---------------------------------------------------------------------------
// P2 — REMOTE delegation
// ---------------------------------------------------------------------------

describe("buildRemoteDelegate (task via the safe startupArgs argv channel)", () => {
  it("profile = type; interactive task is the bare positional argv", () => {
    expect(buildRemoteDelegate("claude", "do X", false)).toEqual({
      profile: "claude",
      startupArgs: ["do X"],
    });
    expect(buildRemoteDelegate("codex", "do X", false)).toEqual({
      profile: "codex",
      startupArgs: ["do X"],
    });
    expect(buildRemoteDelegate("agy", "do X", false)).toEqual({
      profile: "agy",
      startupArgs: ["do X"],
    });
  });

  it("headless drops the binary, keeps the per-type flags + task token", () => {
    // The profile already provides the binary on the Pod; startupArgs is only
    // what TRAILS it — never the binary name itself.
    expect(buildRemoteDelegate("claude", "ship it", true)).toEqual({
      profile: "claude",
      startupArgs: ["-p", "ship it"],
    });
    expect(buildRemoteDelegate("codex", "ship it", true)).toEqual({
      profile: "codex",
      startupArgs: ["exec", "ship it"],
    });
  });

  it("a task with shell metacharacters stays ONE argv element (no injection)", () => {
    const evil = '"; rm -rf / #';
    const { startupArgs } = buildRemoteDelegate("claude", evil, false);
    expect(startupArgs).toEqual([evil]);
    expect(startupArgs).toHaveLength(1);
  });

  it("headless agy is rejected (no confirmed headless mode)", () => {
    expect(() => buildRemoteDelegate("agy", "x", true)).toThrow(/headless/);
  });
});

describe("reconcileRemoteJobs (cluster reconciliation vs listRemoteSessions)", () => {
  const remoteJob = (over: Partial<RegistryEntry>): RegistryEntry =>
    jobEntry({ kind: "remote", source: "remote", remoteId: "sess-1", ...over });

  it("a remote job whose Pod is still listed is left alone", () => {
    const jobs = [remoteJob({ id: "a", remoteId: "sess-1" })];
    const live = new Set(["sess-1"]);
    expect(reconcileRemoteJobs(jobs, live, () => undefined)).toEqual([]);
  });

  it("a remote job whose Pod vanished → failed (no result.json)", () => {
    const jobs = [remoteJob({ id: "a", remoteId: "sess-gone" })];
    const live = new Set(["sess-other"]);
    expect(reconcileRemoteJobs(jobs, live, () => undefined)).toEqual([
      { id: "a", to: "failed" },
    ]);
  });

  it("a remote job whose Pod vanished but left a result.json → that state", () => {
    const jobs = [remoteJob({ id: "a", remoteId: "sess-gone" })];
    const live = new Set<string>();
    const readResult = () =>
      ({ state: "done", exitCode: 0 }) as const;
    expect(reconcileRemoteJobs(jobs, live, readResult)).toEqual([
      { id: "a", to: "done" },
    ]);
  });

  it("terminal remote jobs are never reconciled again", () => {
    const jobs = [
      remoteJob({ id: "a", remoteId: "gone", jobState: "done" }),
      remoteJob({ id: "b", remoteId: "gone", jobState: "failed" }),
    ];
    expect(reconcileRemoteJobs(jobs, new Set(), () => undefined)).toEqual([]);
  });

  it("ignores LOCAL jobs and non-job entries entirely", () => {
    const local = jobEntry({ id: "loc", kind: "local-tmux", jobState: "running" });
    const session: RegistryEntry = {
      id: "sess",
      tool: "claude",
      kind: "remote",
      cwd: "/x",
      enrolledAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      source: "remote",
      remoteId: "sess-z",
      // no role:"job" → a plain session, not a delegated job
    };
    expect(
      reconcileRemoteJobs([local, session], new Set(), () => undefined),
    ).toEqual([]);
  });

  it("a remote job with no recorded remoteId is treated as ended (failed)", () => {
    // Build without remoteId at all (exactOptionalPropertyTypes: omit, don't
    // assign undefined). A missing remoteId can never be in the live set.
    const noId: RegistryEntry = {
      id: "a",
      tool: "claude",
      kind: "remote",
      cwd: "/x",
      enrolledAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      source: "remote",
      role: "job",
      jobState: "running",
    };
    expect(
      reconcileRemoteJobs([noId], new Set(["sess-1"]), () => undefined),
    ).toEqual([{ id: "a", to: "failed" }]);
  });
});

// ---------------------------------------------------------------------------
// P4 — spawn-depth clamp + inheritance (Hermes max_spawn_depth)
// ---------------------------------------------------------------------------

describe("clampDepth (1–3, default 1)", () => {
  it("defaults to 1 when missing / non-finite", () => {
    expect(clampDepth(undefined)).toBe(DEFAULT_MAX_DEPTH);
    expect(clampDepth(Number.NaN)).toBe(1);
    expect(clampDepth(Infinity)).toBe(1);
  });
  it("clamps into [1,3] and truncates", () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(-5)).toBe(1);
    expect(clampDepth(2)).toBe(2);
    expect(clampDepth(2.9)).toBe(2);
    expect(clampDepth(3)).toBe(3);
    expect(clampDepth(99)).toBe(3);
  });
});

describe("inheritedDepthBudget + canDelegateAtDepth + childDepthEnvValue", () => {
  it("top-level (no env): clamps the requested --max-depth", () => {
    expect(inheritedDepthBudget(undefined, {})).toBe(1);
    expect(inheritedDepthBudget(3, {})).toBe(3);
    expect(inheritedDepthBudget(9, {})).toBe(3);
  });
  it("inside a job: the inherited (already-decremented) budget wins", () => {
    expect(inheritedDepthBudget(3, { REMOTE_DELEGATE_DEPTH: "2" })).toBe(2);
    expect(inheritedDepthBudget(undefined, { REMOTE_DELEGATE_DEPTH: "0" })).toBe(0);
    // garbage env → fall back to the requested clamp
    expect(inheritedDepthBudget(2, { REMOTE_DELEGATE_DEPTH: "x" })).toBe(2);
    // out-of-range env is clamped
    expect(inheritedDepthBudget(undefined, { REMOTE_DELEGATE_DEPTH: "9" })).toBe(3);
    expect(inheritedDepthBudget(undefined, { REMOTE_DELEGATE_DEPTH: "-1" })).toBe(0);
  });
  it("a budget of 0 refuses further delegation", () => {
    expect(canDelegateAtDepth(0)).toBe(false);
    expect(canDelegateAtDepth(1)).toBe(true);
    expect(canDelegateAtDepth(3)).toBe(true);
  });
  it("the child env is the parent budget minus one, never below 0", () => {
    expect(childDepthEnvValue(3)).toBe("2");
    expect(childDepthEnvValue(1)).toBe("0");
    expect(childDepthEnvValue(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// P4 — queue / cap decision (planNextStarts + hasFreeSlot)
// ---------------------------------------------------------------------------

describe("planNextStarts (which pending jobs to start under the cap)", () => {
  const j = (
    id: string,
    jobState: RegistryEntry["jobState"],
    ageMs = 0,
  ): Pick<RegistryEntry, "id" | "role" | "jobState" | "enrolledAt"> => ({
    id,
    role: "job",
    ...(jobState !== undefined ? { jobState } : {}),
    enrolledAt: new Date(Date.now() - ageMs).toISOString(),
  });

  it("starts pending jobs up to the cap, oldest-first (FIFO)", () => {
    const jobs = [
      j("r1", "running"),
      j("p-new", "pending", 100),
      j("p-old", "pending", 9000),
      j("p-mid", "pending", 5000),
    ];
    // cap 3, 1 running → 2 free → the two OLDEST pending.
    expect(planNextStarts(jobs, 3)).toEqual(["p-old", "p-mid"]);
  });

  it("admits nothing when running already meets the cap", () => {
    const jobs = [j("a", "running"), j("b", "running"), j("c", "pending")];
    expect(planNextStarts(jobs, 2)).toEqual([]);
  });

  it("treats a missing jobState as pending", () => {
    const jobs = [j("a", undefined, 10), j("b", undefined, 5)];
    expect(planNextStarts(jobs, 1)).toEqual(["a"]); // oldest
  });

  it("ignores non-job entries and a non-positive cap", () => {
    // A plain session: no `role` field at all (exactOptionalPropertyTypes: omit).
    const session: Pick<RegistryEntry, "id" | "role" | "jobState" | "enrolledAt"> = {
      id: "s",
      enrolledAt: new Date().toISOString(),
    };
    expect(planNextStarts([session, j("p", "pending")], 1)).toEqual(["p"]);
    expect(planNextStarts([j("p", "pending")], 0)).toEqual([]);
    expect(planNextStarts([j("p", "pending")], -1)).toEqual([]);
  });

  it("the default cap is 16", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(16);
  });
});

describe("hasFreeSlot (delegate's launch-now vs enqueue decision)", () => {
  const run = (n: number): Pick<RegistryEntry, "role" | "jobState">[] =>
    Array.from({ length: n }, () => ({ role: "job" as const, jobState: "running" as const }));

  it("true while running < cap, false at/over the cap", () => {
    expect(hasFreeSlot(run(0), 16)).toBe(true);
    expect(hasFreeSlot(run(15), 16)).toBe(true);
    expect(hasFreeSlot(run(16), 16)).toBe(false);
    expect(hasFreeSlot(run(20), 16)).toBe(false);
  });

  it("pending / terminal jobs don't occupy a slot", () => {
    const jobs = [
      { role: "job" as const, jobState: "running" as const },
      { role: "job" as const, jobState: "pending" as const },
      { role: "job" as const, jobState: "done" as const },
      { role: "job" as const, jobState: "failed" as const },
    ];
    expect(hasFreeSlot(jobs, 2)).toBe(true); // only 1 running < 2
  });

  it("a non-positive cap never has a free slot", () => {
    expect(hasFreeSlot([], 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 — track mirror derivation (job graph = backlog)
// ---------------------------------------------------------------------------

describe("trackItemNewArgs / trackItemRealizeArgs (pure argv, ref by job id)", () => {
  it("new: parents under the WP with role item, title from task, ref job:<id>", () => {
    expect(trackItemNewArgs("wp-42", { id: "build-x", task: "build the thing" })).toEqual([
      "item",
      "new",
      "--parent",
      "wp-42",
      "--role",
      "item",
      "--title",
      "build the thing",
      "--ref",
      "job:build-x",
    ]);
  });

  it("new: falls back to `job <id>` when there is no task", () => {
    expect(trackItemNewArgs("wp-1", { id: "j1" })).toContain("job j1");
  });

  it("realize: closes the item by the same job:<id> ref", () => {
    expect(trackItemRealizeArgs({ id: "j1" })).toEqual([
      "item",
      "realize",
      "--ref",
      "job:j1",
    ]);
  });
});

describe("resolveTrackBin / runTrackMirror (best-effort, never throws)", () => {
  it("resolves `node <realpath>` when track is on PATH", () => {
    expect(
      resolveTrackBin(
        () => "/usr/bin/track",
        (p) => `${p}-real`,
      ),
    ).toEqual({ command: "node", prefix: ["/usr/bin/track-real"] });
  });

  it("returns undefined when track is not installed", () => {
    expect(resolveTrackBin(() => undefined)).toBeUndefined();
  });

  it("runTrackMirror runs the injected runner and reports true", () => {
    const calls: string[][] = [];
    const ran = runTrackMirror(["item", "realize", "--ref", "job:j1"], "/repo", (args) => {
      calls.push([...args]);
      return { status: 0 };
    });
    expect(ran).toBe(true);
    expect(calls).toEqual([["item", "realize", "--ref", "job:j1"]]);
  });

  it("runTrackMirror swallows a throwing runner (delivery is never coupled to track)", () => {
    const ran = runTrackMirror(["item", "new"], "/repo", () => {
      throw new Error("track exploded");
    });
    expect(ran).toBe(false);
  });
});

describe("sweepStaleJobs (M2 — convergence backstop)", () => {
  const job = (over: Partial<RegistryEntry>): RegistryEntry => ({
    id: "j",
    tool: "claude",
    kind: "local-tmux",
    cwd: "/w",
    source: "run",
    role: "job",
    jobState: "running",
    enrolledAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    ...over,
  });
  const NOW = 100 * 3600_000; // 100h epoch
  const MAX = 24 * 3600_000;

  it("fails a running job that is NOT live, has NO result, older than maxAge", () => {
    const stale = job({ id: "stale", lastSeenAt: new Date(0).toISOString() });
    const ids = sweepStaleJobs([stale], {
      isJobLive: () => false,
      hasResult: () => false,
      maxAgeMs: MAX,
      nowMs: NOW,
    });
    expect(ids).toEqual(["stale"]);
  });

  it("leaves a live job, a job with a result, a young job, pending and terminal", () => {
    const jobs = [
      job({ id: "live" }),
      job({ id: "hasResult" }),
      job({ id: "young", lastSeenAt: new Date(NOW - 1000).toISOString() }),
      job({ id: "pending", jobState: "pending" }),
      job({ id: "done", jobState: "done" }),
    ];
    const ids = sweepStaleJobs(jobs, {
      isJobLive: (e) => e.id === "live",
      hasResult: (e) => e.id === "hasResult",
      maxAgeMs: MAX,
      nowMs: NOW,
    });
    expect(ids).toEqual([]);
  });

  it("ignores non-job entries", () => {
    const session = job({ id: "s" });
    delete (session as { role?: unknown }).role;
    expect(
      sweepStaleJobs([session], {
        isJobLive: () => false,
        hasResult: () => false,
        maxAgeMs: MAX,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
});

describe("conductorAdvisory (M3 — warn, never self-heal)", () => {
  const j = (jobState: "pending" | "running" | "done" | "failed") => ({
    role: "job" as const,
    jobState,
  });

  it("warns when there are pending jobs and NO conductor", () => {
    const msg = conductorAdvisory([j("pending"), j("pending"), j("running")], false);
    expect(msg).toContain("2 pending");
    expect(msg).toContain("no active conductor");
    expect(msg).toContain("remote jobs conduct");
  });

  it("silent when a conductor is running", () => {
    expect(conductorAdvisory([j("pending")], true)).toBeUndefined();
  });

  it("silent when there are no pending jobs", () => {
    expect(conductorAdvisory([j("running"), j("done")], false)).toBeUndefined();
  });
});

describe("clampRemoteDepthBudget (remote depth clamp)", () => {
  it("clamps a remote job's budget to at most 1", () => {
    expect(clampRemoteDepthBudget(3)).toBe(1);
    expect(clampRemoteDepthBudget(2)).toBe(1);
    expect(clampRemoteDepthBudget(1)).toBe(1);
    expect(clampRemoteDepthBudget(0)).toBe(0);
  });
});
