import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleClaudeHook,
  installClaudeHooks,
  manualEnroll,
  resolveJobForHook,
} from "./enroll.js";
import { enroll, loadRegistry, type RegistryEntry } from "./registry.js";

// Scratch dir inside the package (never /tmp); NEVER the real ~/.claude.
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "enroll",
);

let scratch: string;
let regPath: string;
let settingsPath: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "e-"));
  regPath = join(scratch, "registry.json");
  settingsPath = join(scratch, "settings.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const START_CMD = "remote enroll --hook claude-start";
const END_CMD = "remote enroll --hook claude-end";

type Settings = {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  [k: string]: unknown;
};

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function countCommand(settings: Settings, event: string, command: string): number {
  return (settings.hooks?.[event] ?? []).reduce(
    (n, m) => n + (m.hooks ?? []).filter((h) => h.command === command).length,
    0,
  );
}

describe("installClaudeHooks", () => {
  it("creates settings.json with both hooks when none exists (no backup)", () => {
    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);
    expect(result.installed.sort()).toEqual(["SessionEnd", "SessionStart"]);
    expect(result.backupPath).toBeUndefined();
    const settings = readSettings();
    expect(countCommand(settings, "SessionStart", START_CMD)).toBe(1);
    expect(countCommand(settings, "SessionEnd", END_CMD)).toBe(1);
  });

  it("is idempotent: second run changes nothing, no duplicate, single backup", () => {
    // Pre-existing settings with user content + an unrelated SessionStart hook.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo user-hook" }] },
          ],
        },
      }),
      "utf8",
    );

    const first = installClaudeHooks(settingsPath);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    expect(existsSync(first.backupPath!)).toBe(true);
    // backup contains the PRE-modification content
    expect(JSON.parse(readFileSync(first.backupPath!, "utf8")).hooks.SessionStart).toHaveLength(1);

    const second = installClaudeHooks(settingsPath);
    expect(second.changed).toBe(false);
    expect(second.installed).toEqual([]);
    expect(second.backupPath).toBeUndefined();

    const settings = readSettings();
    // user hook untouched, ours present exactly once per event
    expect(countCommand(settings, "SessionStart", "echo user-hook")).toBe(1);
    expect(countCommand(settings, "SessionStart", START_CMD)).toBe(1);
    expect(countCommand(settings, "SessionEnd", END_CMD)).toBe(1);
    expect(settings.model).toBe("opus");
    // exactly one backup was created across the two runs
    const backups = readdirSync(scratch).filter((f) => f.includes(".bak."));
    expect(backups).toHaveLength(1);
  });

  it("refuses to overwrite a corrupt settings file", () => {
    writeFileSync(settingsPath, "{broken", "utf8");
    expect(() => installClaudeHooks(settingsPath)).toThrow(/not valid JSON/);
    expect(readFileSync(settingsPath, "utf8")).toBe("{broken");
  });
});

describe("handleClaudeHook", () => {
  const payload = JSON.stringify({
    session_id: "abc-123",
    cwd: "/home/u/src/projA",
    transcript_path: "/home/u/.claude/projects/x/abc-123.jsonl",
  });

  it("claude-start enrolls a local claude session with convId = session_id", () => {
    expect(handleClaudeHook("claude-start", payload, regPath)).toEqual({ ok: true });
    const entries = loadRegistry(regPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "abc-123",
      tool: "claude",
      kind: "local",
      cwd: "/home/u/src/projA",
      convId: "abc-123",
      source: "hook",
    });
    expect(entries[0]!.endedAt).toBeUndefined();
  });

  it("claude-end marks the session ended (enrolling it first if unknown)", () => {
    handleClaudeHook("claude-start", payload, regPath);
    expect(handleClaudeHook("claude-end", payload, regPath)).toEqual({ ok: true });
    expect(loadRegistry(regPath)[0]!.endedAt).toBeTruthy();

    const other = JSON.stringify({ session_id: "never-started", cwd: "/y" });
    expect(handleClaudeHook("claude-end", other, regPath)).toEqual({ ok: true });
    const entry = loadRegistry(regPath).find((e) => e.id === "never-started");
    expect(entry?.endedAt).toBeTruthy();
  });

  it("never throws: bad JSON, missing session_id, unknown hook -> ok:false", () => {
    expect(handleClaudeHook("claude-start", "not json", regPath).ok).toBe(false);
    expect(handleClaudeHook("claude-start", "{}", regPath).ok).toBe(false);
    expect(handleClaudeHook("claude-oops", payload, regPath).ok).toBe(false);
    expect(loadRegistry(regPath)).toEqual([]);
  });
});

describe("handleClaudeHook — P3 job.done on claude-end for a delegated job", () => {
  const jobPayload = JSON.stringify({ session_id: "claude-job1", cwd: "/work" });

  it("advances the job to done and emits a job.done callback (emit injected)", () => {
    // Enroll a role:"job" entry directly into the scratch registry.
    enroll(
      {
        id: "claude-job1",
        tool: "claude",
        kind: "local-tmux",
        cwd: "/work",
        source: "run",
        role: "job",
        jobState: "running",
        callbackTo: "claude:parent:1",
        task: "do X",
      },
      regPath,
    );
    const emitted: RegistryEntry[] = [];
    const r = handleClaudeHook("claude-end", jobPayload, regPath, {
      emit: (job) => {
        emitted.push(job);
        return { emitted: true, path: "/scratch/x.json", written: true, to: job.callbackTo! };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.callback).toEqual({
      emitted: true,
      path: "/scratch/x.json",
      written: true,
      to: "claude:parent:1",
    });
    // job advanced to done in the registry
    const entry = loadRegistry(regPath).find((e) => e.id === "claude-job1");
    expect(entry?.jobState).toBe("done");
    expect(entry?.endedAt).toBeTruthy();
    // the emit saw the advanced (done) entry
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobState).toBe("done");
  });

  it("STILL exits ok even if the emit throws (callback failure never breaks the hook)", () => {
    enroll(
      {
        id: "claude-job2",
        tool: "claude",
        kind: "local-tmux",
        cwd: "/work",
        source: "run",
        role: "job",
        jobState: "running",
        callbackTo: "p",
      },
      regPath,
    );
    const r = handleClaudeHook(
      "claude-end",
      JSON.stringify({ session_id: "claude-job2", cwd: "/work" }),
      regPath,
      {
        emit: () => {
          throw new Error("boom");
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.callback?.emitted).toBe(false);
    expect(loadRegistry(regPath).find((e) => e.id === "claude-job2")?.jobState).toBe(
      "done",
    );
  });

  it("a non-job session end is untouched (no callback field)", () => {
    enroll(
      { id: "plain-1", tool: "claude", kind: "local", cwd: "/work", source: "hook" },
      regPath,
    );
    const r = handleClaudeHook(
      "claude-end",
      JSON.stringify({ session_id: "plain-1", cwd: "/work" }),
      regPath,
    );
    expect(r).toEqual({ ok: true });
  });
});

describe("H1 — job resolved by REMOTE_JOB_ID / convId, not session_id slug", () => {
  // A delegated interactive job lives under its SLUG; the SessionEnd hook only
  // sees claude's conversation uuid. Without the env/convId link the job would
  // never complete. These cover the fix end-to-end.
  const enrollJob = (id: string) =>
    enroll(
      {
        id,
        tool: "claude",
        kind: "local-tmux",
        cwd: "/work",
        source: "run",
        role: "job",
        jobState: "running",
        callbackTo: "claude:parent:1",
      },
      regPath,
    );

  it("resolveJobForHook prefers REMOTE_JOB_ID, then convId, then id", () => {
    const job: RegistryEntry = {
      id: "job-slug",
      tool: "claude",
      kind: "local-tmux",
      cwd: "/w",
      source: "run",
      role: "job",
      jobState: "running",
      convId: "uuid-xyz",
      enrolledAt: "x",
      lastSeenAt: "x",
    };
    // by env
    expect(resolveJobForHook([job], "irrelevant", "job-slug")?.id).toBe("job-slug");
    // by convId link
    expect(resolveJobForHook([job], "uuid-xyz", undefined)?.id).toBe("job-slug");
    // no match
    expect(resolveJobForHook([job], "nope", "other")).toBeUndefined();
  });

  it("claude-start LINKS the conversation uuid onto the job (convId) via REMOTE_JOB_ID", () => {
    enrollJob("job-A");
    const r = handleClaudeHook(
      "claude-start",
      JSON.stringify({ session_id: "conv-uuid-A", cwd: "/work" }),
      regPath,
      { env: { REMOTE_JOB_ID: "job-A" } },
    );
    expect(r).toEqual({ ok: true, jobId: "job-A" });
    const job = loadRegistry(regPath).find((e) => e.id === "job-A");
    expect(job?.convId).toBe("conv-uuid-A");
    // It did NOT create a stray entry keyed by the uuid.
    expect(loadRegistry(regPath).some((e) => e.id === "conv-uuid-A")).toBe(false);
  });

  it("claude-end completes the job via REMOTE_JOB_ID even when session_id != slug", () => {
    enrollJob("job-B");
    const r = handleClaudeHook(
      "claude-end",
      JSON.stringify({ session_id: "conv-uuid-B", cwd: "/work" }),
      regPath,
      {
        env: { REMOTE_JOB_ID: "job-B" },
        emit: (job) => ({
          emitted: true,
          path: "/x.json",
          written: true,
          to: job.callbackTo!,
        }),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.jobId).toBe("job-B");
    expect(loadRegistry(regPath).find((e) => e.id === "job-B")?.jobState).toBe(
      "done",
    );
  });

  it("claude-end completes the job via the convId link when the env is gone", () => {
    enrollJob("job-C");
    // SessionStart linked the uuid; SessionEnd arrives WITHOUT REMOTE_JOB_ID.
    handleClaudeHook(
      "claude-start",
      JSON.stringify({ session_id: "conv-uuid-C", cwd: "/work" }),
      regPath,
      { env: { REMOTE_JOB_ID: "job-C" } },
    );
    const r = handleClaudeHook(
      "claude-end",
      JSON.stringify({ session_id: "conv-uuid-C", cwd: "/work" }),
      regPath,
      { env: {}, emit: () => ({ emitted: false, reason: "no-parent" }) },
    );
    expect(r.jobId).toBe("job-C");
    expect(loadRegistry(regPath).find((e) => e.id === "job-C")?.jobState).toBe(
      "done",
    );
  });

  it("claude-start with REMOTE_JOB_ID but no such job enrolls a plain session", () => {
    const r = handleClaudeHook(
      "claude-start",
      JSON.stringify({ session_id: "lone-uuid", cwd: "/work" }),
      regPath,
      { env: { REMOTE_JOB_ID: "ghost-job" } },
    );
    expect(r).toEqual({ ok: true });
    const e = loadRegistry(regPath).find((x) => x.id === "lone-uuid");
    expect(e?.role).toBeUndefined();
    expect(e?.convId).toBe("lone-uuid");
  });
});

describe("manualEnroll", () => {
  it("enrolls a local entry keyed by --conv with pid for liveness", () => {
    const result = manualEnroll(
      { tool: "codex", cwd: "/home/u/src/projB", conv: "roll-7", pid: "4242", label: "projB" },
      regPath,
    );
    expect(result.ok).toBe(true);
    expect(loadRegistry(regPath)[0]).toMatchObject({
      id: "roll-7",
      tool: "codex",
      kind: "local",
      cwd: "/home/u/src/projB",
      convId: "roll-7",
      pid: 4242,
      label: "projB",
      source: "run",
    });
  });

  it("rejects unknown tools and bad pids", () => {
    expect(manualEnroll({ tool: "vim" }, regPath).ok).toBe(false);
    expect(manualEnroll({ tool: "claude", pid: "abc" }, regPath).ok).toBe(false);
    expect(loadRegistry(regPath)).toEqual([]);
  });
});
