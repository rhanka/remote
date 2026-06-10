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
  prune,
  touchEntry,
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
