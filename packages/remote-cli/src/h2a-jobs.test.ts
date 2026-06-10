import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authenticateJobEnvelopes,
  buildDecisionReply,
  buildDecisionRequested,
  buildJobDoneEnvelope,
  dropEnvelope,
  emitJobDone,
  envelopeActorInstance,
  envelopeFileName,
  isAwaitingDecision,
  isEnvelopeFromExpected,
  jobDoneFileName,
  jobInstance,
  parentInstance,
  pendingDecisions,
  readInboxEnvelopes,
  renderPendingDecisions,
  repliedDecisionJobIds,
  type ExpectedInstanceResolver,
  type H2aEnvelope,
} from "./h2a-jobs.js";
import type { RegistryEntry } from "./registry.js";

// Scratch dir inside the package (never /tmp, never the real ~/h2a-workspace).
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "h2a-jobs",
);

let scratch: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "j-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const baseJob = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: "claude-foo",
  tool: "claude",
  kind: "local-tmux",
  cwd: "/work",
  enrolledAt: "2026-06-09T00:00:00.000Z",
  lastSeenAt: "2026-06-09T00:00:00.000Z",
  source: "run",
  role: "job",
  jobState: "running",
  ...over,
});

describe("jobInstance — h2a instance of the job's agent", () => {
  it("local job → <tool>:job:<id>", () => {
    expect(jobInstance(baseJob())).toBe("claude:job:claude-foo");
    expect(jobInstance(baseJob({ tool: "codex", id: "x1" }))).toBe(
      "codex:job:x1",
    );
  });

  it("remote job → <tool>:remote:<sessionId> (bridge default mapping)", () => {
    expect(
      jobInstance(baseJob({ kind: "remote", remoteId: "sess99" })),
    ).toBe("claude:remote:sess99");
  });

  it("remote job without remoteId falls back to id", () => {
    expect(jobInstance(baseJob({ kind: "remote" }))).toBe(
      "claude:remote:claude-foo",
    );
  });
});

describe("parentInstance — the callback recipient", () => {
  it("returns callbackTo when set, undefined otherwise", () => {
    expect(parentInstance(baseJob({ callbackTo: "claude:parent:1" }))).toBe(
      "claude:parent:1",
    );
    expect(parentInstance(baseJob())).toBeUndefined();
    expect(parentInstance(baseJob({ callbackTo: "" }))).toBeUndefined();
  });
});

describe("buildJobDoneEnvelope — agent → parent", () => {
  it("mirrors the on-disk h2a shape, type job.done, body has jobId/type/state", () => {
    const env = buildJobDoneEnvelope({
      job: baseJob(),
      to: "claude:parent:1",
      state: "done",
      exitCode: 0,
      summary: "all green",
      resultRef: "/work/.remote/jobs/claude-foo/result.json",
      nowMs: 1780000000000,
    });
    expect(env.protocol).toBe("sentropic.h2a");
    expect(env.version).toBe("0.1");
    expect(env.type).toBe("job.done");
    expect(env.to).toBe("claude:parent:1");
    expect(env.actor.instance).toBe("claude:job:claude-foo");
    expect(env.body).toEqual({
      jobId: "claude-foo",
      type: "claude",
      state: "done",
      exitCode: 0,
      summary: "all green",
      resultRef: "/work/.remote/jobs/claude-foo/result.json",
    });
    expect(env.createdAt).toBe(new Date(1780000000000).toISOString());
  });

  it("omits optional body fields when absent", () => {
    const env = buildJobDoneEnvelope({
      job: baseJob(),
      to: "p",
      state: "failed",
      nowMs: 1,
    });
    expect(env.body).toEqual({ jobId: "claude-foo", type: "claude", state: "failed" });
  });
});

describe("buildDecisionRequested / buildDecisionReply", () => {
  it("decision.requested: agent → parent, body jobId+question(+options)", () => {
    const env = buildDecisionRequested({
      job: baseJob(),
      to: "claude:parent:1",
      question: "deploy to prod?",
      options: ["yes", "no"],
      nowMs: 2,
    });
    expect(env.type).toBe("decision.requested");
    expect(env.to).toBe("claude:parent:1");
    expect(env.actor.instance).toBe("claude:job:claude-foo");
    expect(env.body).toEqual({
      jobId: "claude-foo",
      question: "deploy to prod?",
      options: ["yes", "no"],
    });
  });

  it("decision.reply: parent → agent inbox, body jobId+answer (answer opaque)", () => {
    const evil = '"; rm -rf / #';
    const env = buildDecisionReply({
      job: baseJob(),
      parentInstance: "claude:parent:1",
      answer: evil,
      nowMs: 3,
    });
    expect(env.type).toBe("decision.reply");
    expect(env.actor.instance).toBe("claude:parent:1");
    expect(env.to).toBe("claude:job:claude-foo"); // addressed to the JOB
    expect(env.body).toEqual({ jobId: "claude-foo", answer: evil });
  });
});

describe("envelope file names (SAFE_ENTRY shape: <name>.json, '.'→'_')", () => {
  it("envelopeFileName slugifies the dotted type", () => {
    expect(envelopeFileName("decision.reply", "claude-foo", 7)).toBe(
      "env__7__decision_reply-claude-foo.json",
    );
  });
  it("jobDoneFileName is timestamp-free (one per job → idempotent)", () => {
    expect(jobDoneFileName("claude-foo")).toBe("env__job_done-claude-foo.json");
    expect(jobDoneFileName("claude-foo")).toBe(jobDoneFileName("claude-foo"));
  });
});

describe("dropEnvelope — idempotent by file name, never overwrites", () => {
  it("writes into inbox/<to-dir>/<file>, ':' → '__'", () => {
    const env = buildJobDoneEnvelope({
      job: baseJob(),
      to: "claude:remote:abc",
      state: "done",
      nowMs: 1,
    });
    const r = dropEnvelope(env, jobDoneFileName("claude-foo"), scratch);
    expect(r.written).toBe(true);
    expect(r.path).toBe(
      join(scratch, "inbox", "claude__remote__abc", "env__job_done-claude-foo.json"),
    );
    const onDisk = JSON.parse(readFileSync(r.path, "utf8"));
    expect(onDisk.type).toBe("job.done");
  });

  it("a second drop with the same file name is a no-op (written:false)", () => {
    const env = buildJobDoneEnvelope({ job: baseJob(), to: "p", state: "done", nowMs: 1 });
    const a = dropEnvelope(env, jobDoneFileName("claude-foo"), scratch);
    const b = dropEnvelope(env, jobDoneFileName("claude-foo"), scratch);
    expect(a.written).toBe(true);
    expect(b.written).toBe(false);
    expect(a.path).toBe(b.path);
  });
});

describe("emitJobDone — best-effort, never throws", () => {
  it("no callbackTo → emitted:false no-parent (nothing written)", () => {
    const r = emitJobDone(baseJob(), { state: "done", localRoot: scratch });
    expect(r).toEqual({ emitted: false, reason: "no-parent" });
  });

  it("with callbackTo → drops a stable-named job.done into the parent inbox", () => {
    const job = baseJob({ callbackTo: "claude:parent:1", endedAt: "2026-06-09T01:00:00.000Z" });
    const r = emitJobDone(job, { state: "done", exitCode: 0, localRoot: scratch });
    expect(r.emitted).toBe(true);
    if (r.emitted) {
      expect(r.to).toBe("claude:parent:1");
      expect(r.written).toBe(true);
      expect(r.path).toContain(join("claude__parent__1", "env__job_done-claude-foo.json"));
    }
    // idempotent: a second emit for the same job writes nothing new
    const again = emitJobDone(job, { state: "done", localRoot: scratch });
    if (again.emitted) expect(again.written).toBe(false);
  });

  it("an invalid job id is swallowed into emitted:false (never throws)", () => {
    const job = baseJob({ id: "bad id!", callbackTo: "p" });
    const r = emitJobDone(job, { state: "done", localRoot: scratch });
    expect(r.emitted).toBe(false);
  });
});

describe("decision listing (pure over envelopes)", () => {
  const reqA: H2aEnvelope<unknown> = buildDecisionRequested({
    job: baseJob({ id: "jobA" }),
    to: "p",
    question: "Q-A",
    nowMs: 1,
  });
  const reqB: H2aEnvelope<unknown> = buildDecisionRequested({
    job: baseJob({ id: "jobB" }),
    to: "p",
    question: "Q-B",
    options: ["x", "y"],
    nowMs: 2,
  });
  const replyA: H2aEnvelope<unknown> = buildDecisionReply({
    job: baseJob({ id: "jobA" }),
    parentInstance: "p",
    answer: "go",
    nowMs: 3,
  });

  it("repliedDecisionJobIds collects jobIds with a decision.reply", () => {
    expect([...repliedDecisionJobIds([reqA, reqB, replyA])]).toEqual(["jobA"]);
  });

  it("pendingDecisions returns requests without a matching reply", () => {
    const replied = repliedDecisionJobIds([reqA, reqB, replyA]);
    const pending = pendingDecisions([reqA, reqB, replyA], replied);
    expect(pending.map((d) => d.jobId)).toEqual(["jobB"]);
    expect(pending[0]?.question).toBe("Q-B");
    expect(pending[0]?.options).toEqual(["x", "y"]);
  });

  it("isAwaitingDecision is true only for an unanswered request", () => {
    expect(isAwaitingDecision("jobA", [reqA, replyA])).toBe(false);
    expect(isAwaitingDecision("jobB", [reqA, reqB, replyA])).toBe(true);
    expect(isAwaitingDecision("jobZ", [reqA, reqB])).toBe(false);
  });

  it("renderPendingDecisions shows job id + question, never the full envelope", () => {
    const out = renderPendingDecisions([
      { jobId: "jobB", question: "Q-B", options: ["x", "y"], envelopeId: "env:2:x" },
    ]);
    expect(out).toContain("jobB");
    expect(out).toContain("Q-B");
    expect(out).toContain("[x | y]");
    expect(out).not.toContain("env:2:x"); // envelope id is not leaked
  });

  it("empty → friendly placeholder", () => {
    expect(renderPendingDecisions([])).toBe("(no pending decisions)");
  });
});

describe("readInboxEnvelopes — fs read isolated, tolerant of junk", () => {
  it("reads valid envelopes, skips non-JSON / non-envelope files", () => {
    const dir = join(scratch, "inbox", "claude__job__jobA");
    mkdirSync(dir, { recursive: true });
    const req = buildDecisionRequested({
      job: baseJob({ id: "jobA" }),
      to: "p",
      question: "Q-A",
      nowMs: 1,
    });
    writeFileSync(join(dir, "env__1__req.json"), JSON.stringify(req));
    writeFileSync(join(dir, "garbage.json"), "{not json");
    writeFileSync(join(dir, "not-envelope.json"), JSON.stringify({ hello: 1 }));
    writeFileSync(join(dir, "ignore.txt"), "x");
    const envs = readInboxEnvelopes(scratch);
    expect(envs).toHaveLength(1);
    expect(envs[0]?.type).toBe("decision.requested");
  });

  it("missing store → empty list (no throw)", () => {
    expect(readInboxEnvelopes(join(scratch, "nope"))).toEqual([]);
  });
});

describe("S1 — envelope authentication (multi-tenant RWX)", () => {
  // A job.done / decision.requested ABOUT job X must come FROM X's own agent
  // (actor.instance === jobInstance(X)); a decision.reply must come from X's
  // recorded parent. A forged cross-job envelope is dropped.
  const jobA = baseJob({ id: "jobA", callbackTo: "claude:parent:1" });
  const reqA = buildDecisionRequested({ job: jobA, to: "p", question: "Q", nowMs: 1 });
  const doneA = buildJobDoneEnvelope({ job: jobA, to: "p", state: "done", nowMs: 2 });
  const replyA = buildDecisionReply({
    job: jobA,
    parentInstance: "claude:parent:1",
    answer: "go",
    nowMs: 3,
  });

  // Resolver mirroring the CLI's: jobInstance for job.done/decision.requested,
  // the recorded parent for decision.reply.
  const resolver: ExpectedInstanceResolver = (jobId, type) => {
    if (jobId !== "jobA") return undefined;
    if (type === "decision.reply") return "claude:parent:1";
    return jobInstance(jobA);
  };

  it("envelopeActorInstance reads actor.instance", () => {
    expect(envelopeActorInstance(reqA)).toBe("claude:job:jobA");
  });

  it("isEnvelopeFromExpected rejects an undefined/wrong expected instance", () => {
    expect(isEnvelopeFromExpected(reqA, undefined)).toBe(false);
    expect(isEnvelopeFromExpected(reqA, "claude:job:jobA")).toBe(true);
    expect(isEnvelopeFromExpected(reqA, "claude:job:evil")).toBe(false);
  });

  it("keeps genuine envelopes whose actor matches the job's instance", () => {
    const kept = authenticateJobEnvelopes([reqA, doneA, replyA], resolver);
    expect(kept).toHaveLength(3);
  });

  it("DROPS a forged decision.requested (wrong actor) for a neighbour's job", () => {
    const forged: H2aEnvelope<unknown> = {
      ...reqA,
      actor: { instance: "claude:job:attacker", role: "AGENTS", scope: "s" },
    };
    const kept = authenticateJobEnvelopes([forged], resolver);
    expect(kept).toHaveLength(0);
  });

  it("DROPS a forged decision.reply not from the recorded parent", () => {
    const forged: H2aEnvelope<unknown> = {
      ...replyA,
      actor: { instance: "claude:job:attacker", role: "AGENTS", scope: "s" },
    };
    expect(authenticateJobEnvelopes([forged], resolver)).toHaveLength(0);
    // a genuine reply from the recorded parent survives
    expect(authenticateJobEnvelopes([replyA], resolver)).toHaveLength(1);
  });

  it("DROPS a forged job.done for a job the actor doesn't own", () => {
    const forged: H2aEnvelope<unknown> = {
      ...doneA,
      actor: { instance: "claude:job:other", role: "AGENTS", scope: "s" },
    };
    expect(authenticateJobEnvelopes([forged], resolver)).toHaveLength(0);
  });

  it("DROPS an envelope for an unknown job (resolver → undefined → fail closed)", () => {
    const unknown = buildDecisionRequested({
      job: baseJob({ id: "ghost" }),
      to: "p",
      question: "Q",
      nowMs: 9,
    });
    expect(authenticateJobEnvelopes([unknown], resolver)).toHaveLength(0);
  });

  it("passes through non-job envelope types untouched", () => {
    const other = {
      protocol: "sentropic.h2a",
      version: "0.1",
      id: "x",
      type: "negotiation.offer",
      actor: { instance: "whoever", role: "r", scope: "s" },
      to: "p",
      body: {},
      createdAt: "t",
    } as unknown as H2aEnvelope<unknown>;
    expect(authenticateJobEnvelopes([other], resolver)).toEqual([other]);
  });
});
