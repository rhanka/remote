import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceJob,
  canTransitionJob,
  enroll,
  listJobs,
  listLive,
  loadRegistry,
  markEnded,
  occupiesSlot,
  prune,
  touchEntry,
  tryClaimSlot,
  withRegistryLock,
  type RegistryEntry,
} from "./registry.js";

// Scratch dir inside the package (never /tmp), like the other test suites.
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "registry",
);

let scratch: string;
let regPath: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "r-"));
  regPath = join(scratch, "registry.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const baseInput = {
  id: "sess-1",
  tool: "claude" as const,
  kind: "local-tmux" as const,
  cwd: "/home/u/src/projA",
  source: "run" as const,
  tmuxSession: "remote-projA",
};

describe("registry", () => {
  it("enroll creates the file atomically and loadRegistry round-trips", () => {
    const entry = enroll(baseInput, regPath);
    expect(entry.enrolledAt).toBeTruthy();
    expect(entry.lastSeenAt).toBeTruthy();
    expect(existsSync(regPath)).toBe(true);
    // no leftover tmp file from the atomic write
    expect(readdirSync(scratch)).toEqual(["registry.json"]);
    const loaded = loadRegistry(regPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: "sess-1",
      tool: "claude",
      kind: "local-tmux",
      cwd: "/home/u/src/projA",
      tmuxSession: "remote-projA",
      source: "run",
    });
  });

  it("enroll upserts by id: keeps enrolledAt, merges fields, no duplicates", () => {
    const first = enroll(baseInput, regPath);
    const second = enroll(
      { ...baseInput, convId: "conv-42", label: "projA" },
      regPath,
    );
    expect(second.enrolledAt).toBe(first.enrolledAt);
    expect(second.convId).toBe("conv-42");
    expect(second.label).toBe("projA");
    const loaded = loadRegistry(regPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.convId).toBe("conv-42");
    // fields not repeated on re-enroll are preserved
    const third = enroll(baseInput, regPath);
    expect(third.convId).toBe("conv-42");
  });

  it("re-enrolling an ended session revives it (endedAt dropped)", () => {
    enroll(baseInput, regPath);
    expect(markEnded("sess-1", regPath)).toBe(true);
    expect(loadRegistry(regPath)[0]!.endedAt).toBeTruthy();
    enroll(baseInput, regPath);
    expect(loadRegistry(regPath)[0]!.endedAt).toBeUndefined();
  });

  it("touchEntry refreshes lastSeenAt and reports unknown ids", () => {
    enroll(baseInput, regPath);
    const before = loadRegistry(regPath)[0]!.lastSeenAt;
    expect(touchEntry("sess-1", regPath)).toBe(true);
    expect(Date.parse(loadRegistry(regPath)[0]!.lastSeenAt)).toBeGreaterThanOrEqual(
      Date.parse(before),
    );
    expect(touchEntry("nope", regPath)).toBe(false);
  });

  it("markEnded sets endedAt and reports unknown ids", () => {
    enroll(baseInput, regPath);
    expect(markEnded("sess-1", regPath)).toBe(true);
    expect(loadRegistry(regPath)[0]!.endedAt).toBeTruthy();
    expect(markEnded("nope", regPath)).toBe(false);
  });

  it("loadRegistry tolerates a missing or corrupt file", () => {
    expect(loadRegistry(regPath)).toEqual([]);
    writeFileSync(regPath, "{not json", "utf8");
    expect(loadRegistry(regPath)).toEqual([]);
  });

  describe("listLive", () => {
    it("local-tmux liveness follows tmux has-session", () => {
      enroll(baseInput, regPath);
      enroll(
        { ...baseInput, id: "sess-2", tmuxSession: "remote-gone" },
        regPath,
      );
      const live = listLive({
        path: regPath,
        tmuxHasSession: (name) => name === "remote-projA",
      });
      expect(live.map((e) => e.id)).toEqual(["sess-1"]);
    });

    it("local liveness follows pid (kill(pid, 0)) and endedAt", () => {
      enroll(
        { id: "with-pid", tool: "codex", kind: "local", cwd: "/x", source: "run", pid: 1234 },
        regPath,
      );
      enroll(
        { id: "dead-pid", tool: "codex", kind: "local", cwd: "/x", source: "run", pid: 9999 },
        regPath,
      );
      enroll(
        { id: "no-pid", tool: "claude", kind: "local", cwd: "/x", source: "hook" },
        regPath,
      );
      enroll(
        { id: "ended", tool: "claude", kind: "local", cwd: "/x", source: "hook" },
        regPath,
      );
      markEnded("ended", regPath);
      const live = listLive({
        path: regPath,
        pidAlive: (pid) => pid === 1234,
        bootTimeMs: 0, // boot at epoch → entries (seen now) are post-boot
      });
      // no-pid local entries are trusted until SessionEnd/prune
      expect(live.map((e) => e.id).sort()).toEqual(["no-pid", "with-pid"]);
    });

    it("a local entry last seen BEFORE boot is dead even if its PID is now reused", () => {
      // The crash-reboot case: the process died, but its old PID was reassigned
      // to an unrelated live process. Without the boot guard, kill(pid,0) would
      // falsely report it live and the single-writer guard would block restore.
      enroll(
        { id: "pre-boot", tool: "claude", kind: "local", cwd: "/x", source: "hook", pid: 1234 },
        regPath,
      );
      const live = listLive({
        path: regPath,
        pidAlive: () => true, // PID 1234 is "alive" (reused by another process)
        bootTimeMs: Date.now() + 60_000, // pretend the machine booted AFTER enrol
      });
      expect(live.map((e) => e.id)).toEqual([]); // correctly treated as dead
    });

    it("remote entries are always returned (caller reconciles)", () => {
      enroll(
        { id: "scw-1", tool: "claude", kind: "remote", cwd: "/w", source: "remote", remoteId: "scw-1" },
        regPath,
      );
      expect(listLive({ path: regPath }).map((e) => e.id)).toEqual(["scw-1"]);
    });
  });

  describe("prune", () => {
    it("drops dead entries older than maxAgeHours, keeps live and recent ones", () => {
      const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
      const entries: RegistryEntry[] = [
        // dead (tmux gone) and old -> pruned
        { id: "dead-old", tool: "claude", kind: "local-tmux", cwd: "/a", tmuxSession: "remote-a", enrolledAt: old, lastSeenAt: old, source: "run" },
        // dead but recent -> kept (restore-after-reboot still wants it)
        { id: "dead-recent", tool: "claude", kind: "local-tmux", cwd: "/b", tmuxSession: "remote-b", enrolledAt: old, lastSeenAt: new Date().toISOString(), source: "run" },
        // live and old -> kept
        { id: "live-old", tool: "codex", kind: "local-tmux", cwd: "/c", tmuxSession: "remote-c", enrolledAt: old, lastSeenAt: old, source: "run" },
      ];
      writeFileSync(regPath, JSON.stringify({ version: 1, entries }), "utf8");
      const removed = prune(48, {
        path: regPath,
        tmuxHasSession: (name) => name === "remote-c",
      });
      expect(removed).toBe(1);
      expect(loadRegistry(regPath).map((e) => e.id).sort()).toEqual([
        "dead-recent",
        "live-old",
      ]);
    });

    it("is a no-op (no rewrite) when nothing is prunable", () => {
      enroll(baseInput, regPath);
      const before = readFileSync(regPath, "utf8");
      expect(prune(48, { path: regPath, tmuxHasSession: () => true })).toBe(0);
      expect(readFileSync(regPath, "utf8")).toBe(before);
    });
  });

  describe("delegated jobs (role:'job')", () => {
    const jobInput = {
      id: "job-1",
      tool: "codex" as const,
      kind: "local-tmux" as const,
      cwd: "/home/u/src/projA/.remote/jobs/job-1/wt",
      source: "run" as const,
      tmuxSession: "remote-job-1",
      role: "job" as const,
      jobState: "running" as const,
      task: "fix the flaky test",
      parent: "boss",
    };

    it("round-trips the job fields through enroll/loadRegistry", () => {
      enroll(jobInput, regPath);
      const [loaded] = loadRegistry(regPath);
      expect(loaded).toMatchObject({
        id: "job-1",
        role: "job",
        jobState: "running",
        task: "fix the flaky test",
        parent: "boss",
      });
    });

    it("listJobs returns only role:'job' entries", () => {
      enroll(baseInput, regPath); // a session, not a job
      enroll(jobInput, regPath);
      const jobs = listJobs({ path: regPath });
      expect(jobs.map((j) => j.id)).toEqual(["job-1"]);
    });

    it("a plain session keeps no job fields (back-compat)", () => {
      enroll(baseInput, regPath);
      const [loaded] = loadRegistry(regPath);
      expect(loaded?.role).toBeUndefined();
      expect(loaded?.jobState).toBeUndefined();
    });

    describe("advanceJob state machine", () => {
      it("running -> done stamps endedAt and persists", () => {
        enroll(jobInput, regPath);
        const updated = advanceJob("job-1", "done", regPath);
        expect(updated?.jobState).toBe("done");
        expect(updated?.endedAt).toBeTruthy();
        expect(loadRegistry(regPath)[0]?.jobState).toBe("done");
      });

      it("running -> failed is allowed; done -> running is not", () => {
        enroll(jobInput, regPath);
        expect(advanceJob("job-1", "failed", regPath)?.jobState).toBe("failed");
        // failed is terminal: cannot go back to running
        expect(advanceJob("job-1", "running", regPath)).toBeUndefined();
      });

      it("refuses to advance a non-job or unknown id", () => {
        enroll(baseInput, regPath); // a session
        expect(advanceJob("sess-1", "done", regPath)).toBeUndefined();
        expect(advanceJob("nope", "done", regPath)).toBeUndefined();
      });

      it("canTransitionJob encodes the legal edges", () => {
        expect(canTransitionJob("pending", "running")).toBe(true);
        expect(canTransitionJob("running", "done")).toBe(true);
        expect(canTransitionJob("running", "failed")).toBe(true);
        expect(canTransitionJob("done", "failed")).toBe(false);
        expect(canTransitionJob("pending", "done")).toBe(false);
      });
    });

    // Reliability slice 1 — rate-limit "throttled" state (HEADLESS LOCAL).
    describe("throttled state machine + throttle bookkeeping", () => {
      it("running -> throttled -> running round-trips and is NOT terminal", () => {
        enroll({ ...jobInput, id: "rl-1" }, regPath);
        const t = advanceJob("rl-1", "throttled", regPath);
        expect(t?.jobState).toBe("throttled");
        expect(t?.endedAt).toBeUndefined(); // throttled is non-terminal
        const r = advanceJob("rl-1", "running", regPath);
        expect(r?.jobState).toBe("running");
      });

      it("throttled -> failed (cap spent) stamps endedAt", () => {
        enroll({ ...jobInput, id: "rl-2", jobState: "throttled" }, regPath);
        const f = advanceJob("rl-2", "failed", regPath);
        expect(f?.jobState).toBe("failed");
        expect(f?.endedAt).toBeTruthy();
      });

      it("throttled -> done settles a fresh success", () => {
        enroll({ ...jobInput, id: "rl-3", jobState: "throttled" }, regPath);
        expect(advanceJob("rl-3", "done", regPath)?.jobState).toBe("done");
      });

      it("rejects illegal edges into/out of throttled", () => {
        // pending cannot jump straight to throttled (never launched).
        enroll({ ...jobInput, id: "rl-4", jobState: "pending" }, regPath);
        expect(advanceJob("rl-4", "throttled", regPath)).toBeUndefined();
        // done is terminal — cannot re-enter throttled.
        enroll({ ...jobInput, id: "rl-5", jobState: "done" }, regPath);
        expect(advanceJob("rl-5", "throttled", regPath)).toBeUndefined();
      });

      it("canTransitionJob encodes the throttled edges", () => {
        expect(canTransitionJob("running", "throttled")).toBe(true);
        expect(canTransitionJob("throttled", "running")).toBe(true);
        expect(canTransitionJob("throttled", "failed")).toBe(true);
        expect(canTransitionJob("throttled", "done")).toBe(true);
        expect(canTransitionJob("pending", "throttled")).toBe(false);
        expect(canTransitionJob("done", "throttled")).toBe(false);
      });

      it("round-trips the throttle bookkeeping object through enroll", () => {
        enroll(
          {
            ...jobInput,
            id: "rl-6",
            jobState: "throttled",
            throttle: {
              attempts: 3,
              firstAt: "2026-06-11T12:00:00.000Z",
              nextRetryAt: "2026-06-11T12:05:00.000Z",
              lastSignature: "claude:rate-limited",
            },
          },
          regPath,
        );
        const loaded = loadRegistry(regPath).find((e) => e.id === "rl-6");
        expect(loaded?.throttle).toEqual({
          attempts: 3,
          firstAt: "2026-06-11T12:00:00.000Z",
          nextRetryAt: "2026-06-11T12:05:00.000Z",
          lastSignature: "claude:rate-limited",
        });
      });

      it("occupiesSlot: running + throttled occupy a slot; others don't", () => {
        expect(occupiesSlot("running")).toBe(true);
        expect(occupiesSlot("throttled")).toBe(true);
        expect(occupiesSlot("pending")).toBe(false);
        expect(occupiesSlot("done")).toBe(false);
        expect(occupiesSlot("failed")).toBe(false);
      });

      it("tryClaimSlot counts a throttled job against the cap (it keeps its slot)", () => {
        enroll({ ...jobInput, id: "occ-1", jobState: "throttled" }, regPath);
        // cap 1, one throttled job already occupies the slot → no claim.
        const claimed = tryClaimSlot(
          { id: "new", tool: "claude", kind: "local-tmux", cwd: "/r", source: "run", role: "job" },
          1,
          regPath,
        );
        expect(claimed).toBeUndefined();
      });
    });

    describe("P4 queued-launch spec fields", () => {
      it("round-trips the queued-launch fields through enroll (pending job)", () => {
        enroll(
          {
            id: "q-1",
            tool: "claude",
            kind: "local-tmux",
            cwd: "/repo",
            source: "run",
            role: "job",
            jobState: "pending",
            task: "queued task",
            headless: true,
            originCwd: "/repo",
            explicitCwd: "/repo/sub",
            depthBudget: 2,
            remoteTarget: "http://cp:8080",
            trackWp: "wp-9",
          },
          regPath,
        );
        const [loaded] = loadRegistry(regPath);
        expect(loaded).toMatchObject({
          id: "q-1",
          jobState: "pending",
          headless: true,
          originCwd: "/repo",
          explicitCwd: "/repo/sub",
          depthBudget: 2,
          remoteTarget: "http://cp:8080",
          trackWp: "wp-9",
        });
      });

      it("a pending job advances to running (the conductor launch), keeping its spec", () => {
        enroll(
          {
            id: "q-2",
            tool: "claude",
            kind: "local-tmux",
            cwd: "/repo",
            source: "run",
            role: "job",
            jobState: "pending",
            depthBudget: 3,
            trackWp: "wp-1",
          },
          regPath,
        );
        const advanced = advanceJob("q-2", "running", regPath);
        expect(advanced?.jobState).toBe("running");
        expect(advanced?.depthBudget).toBe(3);
        expect(advanced?.trackWp).toBe("wp-1");
      });

      it("a plain session keeps NO queued-launch fields (back-compat)", () => {
        enroll(baseInput, regPath);
        const [loaded] = loadRegistry(regPath);
        expect(loaded?.headless).toBeUndefined();
        expect(loaded?.depthBudget).toBeUndefined();
        expect(loaded?.remoteTarget).toBeUndefined();
        expect(loaded?.trackWp).toBeUndefined();
      });
    });
  });
});

describe("registry concurrency (S2/S3)", () => {
  const jobInput = (id: string) => ({
    id,
    tool: "claude" as const,
    kind: "local-tmux" as const,
    cwd: "/repo",
    source: "run" as const,
    role: "job" as const,
  });

  it("withRegistryLock serializes load-modify-save (no lost write across calls)", () => {
    enroll({ ...jobInput("a"), jobState: "pending" }, regPath);
    enroll({ ...jobInput("b"), jobState: "pending" }, regPath);
    // Two interleaved-looking mutations on DISJOINT entries: under the lock each
    // re-reads the freshest snapshot, so neither clobbers the other.
    withRegistryLock(regPath, (entries) => {
      const e = entries.find((x) => x.id === "a")!;
      e.label = "first";
      return { entries, result: undefined };
    });
    withRegistryLock(regPath, (entries) => {
      const e = entries.find((x) => x.id === "b")!;
      e.label = "second";
      return { entries, result: undefined };
    });
    const all = loadRegistry(regPath);
    expect(all.find((e) => e.id === "a")?.label).toBe("first");
    expect(all.find((e) => e.id === "b")?.label).toBe("second");
  });

  it("withRegistryLock save:false does NOT create/rewrite the file", () => {
    const r = withRegistryLock(regPath, (entries) => ({
      entries,
      result: 42,
      save: false,
    }));
    expect(r).toBe(42);
    expect(existsSync(regPath)).toBe(false);
  });

  it("tryClaimSlot enrolls running while under the cap", () => {
    const claimed = tryClaimSlot(jobInput("j1"), 2, regPath);
    expect(claimed?.jobState).toBe("running");
    expect(loadRegistry(regPath).find((e) => e.id === "j1")?.jobState).toBe(
      "running",
    );
  });

  it("tryClaimSlot REFUSES at the cap and writes nothing (atomic check+enroll)", () => {
    tryClaimSlot(jobInput("r1"), 1, regPath); // fills the only slot
    const before = readFileSync(regPath, "utf8");
    const claimed = tryClaimSlot(jobInput("r2"), 1, regPath);
    expect(claimed).toBeUndefined();
    // r2 was NOT written (no overshoot of the cap, and no stray entry).
    expect(readFileSync(regPath, "utf8")).toBe(before);
    expect(loadRegistry(regPath).some((e) => e.id === "r2")).toBe(false);
  });

  it("tryClaimSlot does not double-count a job already pending as its own slot", () => {
    // Enroll j as pending, then claim it: it should be admitted (it is not yet
    // running, so it doesn't count against the cap as itself).
    enroll({ ...jobInput("j"), jobState: "pending" }, regPath);
    const claimed = tryClaimSlot(jobInput("j"), 1, regPath);
    expect(claimed?.jobState).toBe("running");
  });

  it("the cap counts only RUNNING jobs (pending/terminal free their slot)", () => {
    enroll({ ...jobInput("done1"), jobState: "done" }, regPath);
    enroll({ ...jobInput("pend1"), jobState: "pending" }, regPath);
    // cap 1, no RUNNING job yet → a fresh claim succeeds.
    expect(tryClaimSlot(jobInput("new1"), 1, regPath)?.jobState).toBe("running");
    // now one is running → cap 1 is full.
    expect(tryClaimSlot(jobInput("new2"), 1, regPath)).toBeUndefined();
  });

  it("cap <= 0 admits nothing", () => {
    expect(tryClaimSlot(jobInput("z"), 0, regPath)).toBeUndefined();
    expect(existsSync(regPath)).toBe(false);
  });
});
