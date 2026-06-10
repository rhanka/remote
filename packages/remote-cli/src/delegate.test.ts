import { describe, expect, it, vi } from "vitest";

import {
  assertSafeName,
  buildDelegateArgs,
  buildJobRows,
  isDelegateType,
  jobDir,
  readJobResult,
  reconcileJobState,
  renderJobsTable,
  resolveJobCwd,
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
