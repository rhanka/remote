/**
 * h2a job callback + decision channel — P3 of cross-type agent delegation.
 *
 * Pure helpers (builders + parsing + instance derivation) plus a thin fs layer
 * to DROP an envelope into a local h2a inbox. The bridge (`remote h2a bridge`)
 * already transports envelopes pod↔local and is idempotent by file name, so
 * everything here is best-effort: an undelivered envelope never blocks a job.
 *
 *  - `job.done`        agent → PARENT, when a delegated job terminates (body:
 *                      {jobId, type, state, exitCode?, summary?, resultRef?}).
 *  - `decision.requested`  agent → PARENT, when the job needs a human/parent
 *                      decision (body: {jobId, question, options?}).
 *  - `decision.reply`  PARENT → agent, the answer (body: {jobId, answer}).
 *
 * Envelopes mirror the on-disk h2a shape exactly (the format `h2a-bridge.ts`
 * documents in the Pod README): {protocol, version, id, type, actor:{instance,
 * role, scope}, to, body, createdAt}. They drop into
 * `<localRoot>/inbox/<recipient-dir>/env__<ts>__<slug>.json`, where the dir is
 * the recipient instance id with ":" → "__" — the bridge's SAFE_ENTRY shape.
 *
 * SECURITY: jobId / answer / question ride structured argv → the envelope body,
 * NEVER a shell string. jobId is `assertSafeName`-checked before it becomes a
 * file slug. The bridge itself re-validates every entry name (SAFE_ENTRY).
 *
 * KNOWN LIMIT — depends on agent behavior: a delegated interactive agent must
 * CHOOSE to call its h2a MCP tool (h2a_inbox / write an envelope) to read a
 * `decision.reply` or to emit a `decision.requested`. We build the channel and
 * the transport; we cannot force the agent to use it. `job.done` for an
 * interactive job is independent of that (it rides the SessionEnd hook), and
 * for headless rides reconciliation — neither needs the agent to cooperate.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { assertSafeName, type DelegateType } from "./delegate.js";
import { defaultLocalH2aRoot, instanceInboxDir } from "./h2a-bridge.js";
import type { JobState, RegistryEntry } from "./registry.js";

export const H2A_PROTOCOL = "sentropic.h2a";
export const H2A_VERSION = "0.1";

/** The P3 envelope types (the spec's vocabulary, on the envelope `type` field). */
export type JobEnvelopeType = "job.done" | "decision.requested" | "decision.reply";

export type EnvelopeActor = {
  instance: string;
  role: string;
  scope: string;
};

export type H2aEnvelope<TBody> = {
  protocol: typeof H2A_PROTOCOL;
  version: typeof H2A_VERSION;
  id: string;
  type: JobEnvelopeType;
  actor: EnvelopeActor;
  /** Recipient instance id (who this envelope is addressed to). */
  to: string;
  body: TBody;
  createdAt: string;
};

export type JobDoneBody = {
  jobId: string;
  /** The agent type (claude/codex/agy) so the parent need not re-look-up. */
  type: DelegateType;
  state: JobState;
  exitCode?: number;
  summary?: string;
  resultRef?: string;
};

export type DecisionRequestedBody = {
  jobId: string;
  question: string;
  options?: string[];
};

export type DecisionReplyBody = {
  jobId: string;
  answer: string;
};

const DEFAULT_ROLE = "AGENTS";
const DEFAULT_SCOPE = "scope:default";

/**
 * The h2a INSTANCE id of a delegated job's agent — the inbox a `decision.reply`
 * must reach, and the `actor.instance` on envelopes the job emits.
 *  - remote (kind:"remote"): the Pod default mapping `<tool>:remote:<sessionId>`
 *    (same as `h2a-bridge.ts` defaultPodInstance), so the bridge already routes
 *    to/from it.
 *  - local: `<tool>:job:<jobId>` — a stable, predictable instance for the local
 *    job's h2a side-window. jobId already passed assertSafeName at delegate time.
 * Pure, exported for tests.
 */
export function jobInstance(
  entry: Pick<RegistryEntry, "tool" | "kind" | "id" | "remoteId">,
): string {
  if (entry.kind === "remote") {
    return `${entry.tool}:remote:${entry.remoteId ?? entry.id}`;
  }
  return `${entry.tool}:job:${entry.id}`;
}

/**
 * The PARENT instance to address a callback to: the explicit `callbackTo`
 * recorded on the job at delegate time (`--parent`/`--on-done`), else undefined
 * (no parent → no callback is emitted; best-effort). Pure, exported for tests.
 */
export function parentInstance(
  entry: Pick<RegistryEntry, "callbackTo">,
): string | undefined {
  const to = entry.callbackTo;
  return to && to.length > 0 ? to : undefined;
}

/** A monotonic-ish envelope id slug. Pure given (jobId, kind, ts). */
function envelopeId(kind: string, jobId: string, ts: number): string {
  return `env:${ts}:${kind}-${jobId}`;
}

/** On-disk file name for an envelope — matches the bridge's SAFE_ENTRY shape. */
export function envelopeFileName(
  kind: JobEnvelopeType,
  jobId: string,
  ts: number,
): string {
  // "." in the type is not allowed in a SAFE_ENTRY dir/file segment lead, but
  // is fine mid-name; we slugify it to "_" to stay maximally safe.
  const slug = kind.replace(/\./g, "_");
  return `env__${ts}__${slug}-${jobId}.json`;
}

/**
 * STABLE (timestamp-free) file name for a `job.done` callback: ONE per job, so
 * the SessionEnd hook and the reconcile loop can BOTH attempt the emit and the
 * second one is a no-op (dropEnvelope skips an existing file; the bridge skips
 * by file name too). Idempotency by name, exactly the bridge's contract.
 */
export function jobDoneFileName(jobId: string): string {
  return `env__job_done-${jobId}.json`;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Build a `job.done` envelope: emitted BY the job's agent, addressed TO the
 * parent. The body carries jobId/type/state and optional exitCode/summary/
 * resultRef. Pure, exported for tests (ts/id are injected for determinism).
 */
export function buildJobDoneEnvelope(args: {
  job: Pick<RegistryEntry, "tool" | "kind" | "id" | "remoteId">;
  to: string;
  state: JobState;
  exitCode?: number;
  summary?: string;
  resultRef?: string;
  nowMs?: number;
}): H2aEnvelope<JobDoneBody> {
  const ts = args.nowMs ?? Date.now();
  const body: JobDoneBody = {
    jobId: args.job.id,
    type: args.job.tool,
    state: args.state,
  };
  if (args.exitCode !== undefined) body.exitCode = args.exitCode;
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.resultRef !== undefined) body.resultRef = args.resultRef;
  return {
    protocol: H2A_PROTOCOL,
    version: H2A_VERSION,
    id: envelopeId("job-done", args.job.id, ts),
    type: "job.done",
    actor: { instance: jobInstance(args.job), role: DEFAULT_ROLE, scope: DEFAULT_SCOPE },
    to: args.to,
    body,
    createdAt: nowIso(ts),
  };
}

/**
 * Build a `decision.requested` envelope: emitted BY the job's agent, addressed
 * TO the parent. Pure, exported for tests.
 */
export function buildDecisionRequested(args: {
  job: Pick<RegistryEntry, "tool" | "kind" | "id" | "remoteId">;
  to: string;
  question: string;
  options?: string[];
  nowMs?: number;
}): H2aEnvelope<DecisionRequestedBody> {
  const ts = args.nowMs ?? Date.now();
  const body: DecisionRequestedBody = {
    jobId: args.job.id,
    question: args.question,
  };
  if (args.options !== undefined) body.options = args.options;
  return {
    protocol: H2A_PROTOCOL,
    version: H2A_VERSION,
    id: envelopeId("decision-req", args.job.id, ts),
    type: "decision.requested",
    actor: { instance: jobInstance(args.job), role: DEFAULT_ROLE, scope: DEFAULT_SCOPE },
    to: args.to,
    body,
    createdAt: nowIso(ts),
  };
}

/**
 * Build a `decision.reply` envelope: emitted BY the parent, addressed TO the
 * job's agent inbox. The `answer` is opaque text — passed straight through, no
 * shell concat. Pure, exported for tests.
 */
export function buildDecisionReply(args: {
  job: Pick<RegistryEntry, "tool" | "kind" | "id" | "remoteId">;
  parentInstance: string;
  answer: string;
  nowMs?: number;
}): H2aEnvelope<DecisionReplyBody> {
  const ts = args.nowMs ?? Date.now();
  return {
    protocol: H2A_PROTOCOL,
    version: H2A_VERSION,
    id: envelopeId("decision-reply", args.job.id, ts),
    type: "decision.reply",
    actor: {
      instance: args.parentInstance,
      role: DEFAULT_ROLE,
      scope: DEFAULT_SCOPE,
    },
    to: jobInstance(args.job),
    body: { jobId: args.job.id, answer: args.answer },
    createdAt: nowIso(ts),
  };
}

// ---------------------------------------------------------------------------
// Envelope drop (thin fs layer; idempotent by file name like the bridge)
// ---------------------------------------------------------------------------

export type DropResult = {
  /** Absolute path written (or that already existed). */
  path: string;
  /** false when the file already existed — never overwritten. */
  written: boolean;
};

/**
 * Drop an envelope into `<localRoot>/inbox/<to-dir>/<fileName>`, where <to-dir>
 * is `envelope.to` with ":" → "__". Idempotent by FILE NAME (an existing file is
 * left untouched — same contract as the bridge). The jobId in the file name is
 * already assertSafeName-checked by the caller. Returns where it landed.
 */
export function dropEnvelope(
  envelope: H2aEnvelope<unknown>,
  fileName: string,
  localRoot: string = defaultLocalH2aRoot(),
): DropResult {
  const dir = join(localRoot, "inbox", instanceInboxDir(envelope.to));
  const path = join(dir, fileName);
  if (existsSync(path)) return { path, written: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return { path, written: true };
}

// ---------------------------------------------------------------------------
// Decision listing — read a parent inbox for pending decision.requested
// ---------------------------------------------------------------------------

export type PendingDecision = {
  jobId: string;
  question: string;
  options?: string[];
  /** The envelope id, so a future ack/reply can reference it. */
  envelopeId: string;
};

/** Minimal parse of an on-disk envelope; tolerant of unrelated files. */
function parseEnvelope(raw: string): H2aEnvelope<unknown> | undefined {
  try {
    const e = JSON.parse(raw) as Partial<H2aEnvelope<unknown>>;
    if (
      e.protocol === H2A_PROTOCOL &&
      typeof e.type === "string" &&
      typeof e.id === "string" &&
      e.body !== undefined
    ) {
      return e as H2aEnvelope<unknown>;
    }
  } catch {
    // not an envelope / malformed → skip
  }
  return undefined;
}

/**
 * From a flat list of (fileName, rawJson) envelopes found in the PARENT's inbox
 * and the JOB inboxes, return the `decision.requested` that have NO matching
 * `decision.reply` yet (same jobId). Pure, exported for tests — the fs read is
 * done by the caller so this stays deterministic.
 *
 * A reply is matched to a request by jobId (the channel is one open decision per
 * job at a time; P4 may add a per-request id). `repliedJobIds` is the set of
 * jobIds for which a `decision.reply` exists anywhere we can see.
 */
export function pendingDecisions(
  envelopes: ReadonlyArray<H2aEnvelope<unknown>>,
  repliedJobIds: ReadonlySet<string>,
): PendingDecision[] {
  const out: PendingDecision[] = [];
  for (const e of envelopes) {
    if (e.type !== "decision.requested") continue;
    const body = e.body as Partial<DecisionRequestedBody>;
    if (typeof body.jobId !== "string" || typeof body.question !== "string") {
      continue;
    }
    if (repliedJobIds.has(body.jobId)) continue;
    const d: PendingDecision = {
      jobId: body.jobId,
      question: body.question,
      envelopeId: e.id,
    };
    if (Array.isArray(body.options)) d.options = body.options.map(String);
    out.push(d);
  }
  return out;
}

/** The set of jobIds that already have a `decision.reply` in `envelopes`. Pure. */
export function repliedDecisionJobIds(
  envelopes: ReadonlyArray<H2aEnvelope<unknown>>,
): Set<string> {
  const set = new Set<string>();
  for (const e of envelopes) {
    if (e.type !== "decision.reply") continue;
    const body = e.body as Partial<DecisionReplyBody>;
    if (typeof body.jobId === "string") set.add(body.jobId);
  }
  return set;
}

/**
 * Read every envelope under `<localRoot>/inbox/**` (one dir level deep, the h2a
 * layout). The fs read is isolated HERE so the listing/matching above stays
 * pure. Missing store → empty. Never throws on a bad file (skips it).
 */
export function readInboxEnvelopes(
  localRoot: string = defaultLocalH2aRoot(),
): H2aEnvelope<unknown>[] {
  const inbox = join(localRoot, "inbox");
  if (!existsSync(inbox)) return [];
  const out: H2aEnvelope<unknown>[] = [];
  for (const dir of readdirSync(inbox, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(inbox, dir.name);
    for (const f of readdirSync(dirPath, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dirPath, f.name), "utf8");
      } catch {
        continue;
      }
      const env = parseEnvelope(raw);
      if (env) out.push(env);
    }
  }
  return out;
}

/**
 * Does the job have an UNANSWERED `decision.requested`? Used by `jobs status` to
 * show `awaiting-decision`. Pure over the envelope list, exported for tests.
 */
export function isAwaitingDecision(
  jobId: string,
  envelopes: ReadonlyArray<H2aEnvelope<unknown>>,
): boolean {
  const replied = repliedDecisionJobIds(envelopes);
  return pendingDecisions(envelopes, replied).some((d) => d.jobId === jobId);
}

/**
 * One-line render of a pending decision for `jobs decisions` — jobId + question
 * only (no raw envelope body beyond the essentials, per the security note).
 * Pure, exported for tests.
 */
export function renderPendingDecisions(
  decisions: ReadonlyArray<PendingDecision>,
): string {
  if (decisions.length === 0) return "(no pending decisions)";
  const lines = decisions.map((d) => {
    const opts =
      d.options && d.options.length > 0 ? `  [${d.options.join(" | ")}]` : "";
    return `${d.jobId}\t${d.question}${opts}`;
  });
  return ["JOB\tQUESTION", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// High-level: emit job.done for an entry (best-effort, used by hook + reconcile)
// ---------------------------------------------------------------------------

export type EmitJobDoneResult =
  | { emitted: true; path: string; written: boolean; to: string }
  | { emitted: false; reason: "no-parent" | "error"; error?: string };

/**
 * Best-effort: emit a `job.done` envelope for a finished job into the parent's
 * local inbox. No-op (emitted:false, "no-parent") when the job has no recorded
 * `callbackTo` — a job delegated without a parent simply has nobody to notify.
 * NEVER throws: any fs/build error is swallowed into emitted:false so a callback
 * failure can't take down the SessionEnd hook or the reconcile loop.
 */
export function emitJobDone(
  job: RegistryEntry,
  args: {
    state: JobState;
    exitCode?: number;
    summary?: string;
    resultRef?: string;
    localRoot?: string;
    nowMs?: number;
  } = { state: job.jobState ?? "done" },
): EmitJobDoneResult {
  try {
    const to = parentInstance(job);
    if (!to) return { emitted: false, reason: "no-parent" };
    assertSafeName(job.id);
    // Prefer the job's terminal time so the envelope id is stable across the
    // hook + reconcile paths; the FILE name is timestamp-free (one per job).
    const ts = args.nowMs ?? (job.endedAt ? Date.parse(job.endedAt) : Date.now());
    const envelope = buildJobDoneEnvelope({
      job,
      to,
      state: args.state,
      ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ...(args.resultRef !== undefined ? { resultRef: args.resultRef } : {}),
      nowMs: ts,
    });
    const { path, written } = dropEnvelope(
      envelope,
      jobDoneFileName(job.id),
      args.localRoot,
    );
    return { emitted: true, path, written, to };
  } catch (error) {
    return { emitted: false, reason: "error", error: String(error) };
  }
}
