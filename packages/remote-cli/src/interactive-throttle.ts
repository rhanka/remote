/**
 * Rate-limit ("throttled") AUTO-RESUME for INTERACTIVE LOCAL tmux sessions
 * (reliability slice 2 — throttle phase 2).
 *
 * Slice 1 handled HEADLESS delegated jobs (they exit ≠0 on a transient provider
 * rate-limit; the conductor relaunches them with a continue flag). INTERACTIVE
 * `remote run` sessions (claude / codex / agy in a live tmux pane) do NOT exit —
 * they STALL: the provider returns `API Error: Server is temporarily limiting
 * requests · Rate limited` and the agent sits there until a human pokes it. This
 * module decides which stalled-and-throttled sessions to nudge back to life,
 * staggered (AIMD cap, oldest-first, backoff), and — CRUCIALLY — NEVER touches a
 * pane a human is attached to.
 *
 * SAFETY IS PARAMOUNT (we send keys to LIVE sessions a human may be driving):
 *  - HARD attached guard: a session whose tmux `#{session_attached}` is NOT 0 is
 *    classified `throttled` for the advisory but is NEVER in `toResume`. We only
 *    ever nudge a DETACHED pane.
 *  - STALL corroboration: a throttle SIGNATURE in the pane tail is necessary but
 *    not sufficient — the agent may have printed the error and then recovered on
 *    its own. We require the pane to ALSO be stalled (idle shell OR an unchanged
 *    tail since the previous pass) before nudging, so we never interrupt an agent
 *    that is actively working.
 *  - BACKOFF + attempt cap: each nudge schedules `nextRetryAt = now +
 *    jitteredBackoffMs(attempts)`; a session is only resumed once it is past
 *    `nextRetryAt`, and after `maxAttempts` nudges we give up (advise only).
 *  - STAGGERED: at most the AIMD effective cap of sessions per pass, oldest-first
 *    (the session whose throttle is oldest goes first), so a fleet-wide limit is
 *    not hammered by resuming everyone at once.
 *
 * This module is PURE (no tmux/clock/IO): the caller captures pane tails, reads
 * `session_attached`, probes idleness, and carries the per-session throttle
 * bookkeeping across passes. The thin executor (index.ts) feeds those in, applies
 * the plan with a minimal `send-keys` / relaunch nudge to the detached pane, and
 * is opt-in (default dry-run behind `--resume-throttled`).
 */

import { detectThrottle } from "./throttle-signatures.js";
import {
  jitteredBackoffMs,
  THROTTLE_BACKOFF_BASE_MS,
  THROTTLE_BACKOFF_CAP_MS,
  THROTTLE_MAX_ATTEMPTS,
  type DelegateType,
} from "./delegate.js";

/**
 * The minimal per-session shape the planner needs. Mirrors `LocalSession` from
 * tmux.ts (name/slug/profile) plus the bits that make staggering deterministic.
 */
export type InteractiveSession = {
  /** Full tmux session name (e.g. `remote-surch`) — the resume target. */
  name: string;
  /** The delegate tool driving the pane (selects the detectThrottle signature table). */
  type: DelegateType;
  /**
   * When this session was first seen (ISO or ms). Used ONLY to break ties when
   * two sessions throttled at the same instant — the throttle's own `firstAt`
   * (oldest-throttle-first) is the primary ordering.
   */
  startedAt: string | number;
};

/** Per-session throttle bookkeeping the executor carries across passes. */
export type InteractiveThrottleInfo = {
  /** How many resume nudges this session has received (drives the backoff). */
  attempts: number;
  /** ISO ts of the FIRST throttle observed (oldest-first ordering + history). */
  firstAt: string;
  /** ISO ts the session may be nudged at (now + jitteredBackoffMs(attempts)). */
  nextRetryAt: string;
  /** The signature tag that classified the last throttle. */
  lastSignature?: string;
};

/** A single session the planner decided to nudge this pass. */
export type InteractiveResume = {
  name: string;
  type: DelegateType;
  /** The matched throttle signature (for the advisory + bookkeeping). */
  signature?: string;
  /** 0-based attempt index used for THIS nudge's backoff (prior attempts). */
  attempt: number;
  /** The next bookkeeping to persist after the nudge (attempts bumped, retry rescheduled). */
  next: InteractiveThrottleInfo;
};

/** A session classified `throttled` this pass (resumed or merely advised). */
export type InteractiveThrottled = {
  name: string;
  type: DelegateType;
  signature?: string;
  /** True when the pane is ATTACHED (a human is there) → never nudged, advise only. */
  attached: boolean;
  /** True when the pane is corroborated stalled (idle / unchanged tail). */
  stalled: boolean;
};

export type InteractiveResumePlan = {
  /** Every session classified throttled this pass (attached or detached). */
  throttled: InteractiveThrottled[];
  /** The DETACHED, stalled, due, under-cap sessions to nudge (≤ cap, oldest-first). */
  toResume: InteractiveResume[];
  /** One human-readable line per decision (advisory / would-resume / skip reason). */
  advisories: string[];
};

export type PlanInteractiveResumeOpts = {
  /** The live interactive sessions to consider. */
  sessions: ReadonlyArray<InteractiveSession>;
  /** Now (ms epoch) — injected so the plan is deterministic. */
  now: number;
  /** Per-session prior throttle bookkeeping (by session name), carried across passes. */
  throttleState: Readonly<Record<string, InteractiveThrottleInfo | undefined>>;
  /**
   * Per-session `session_attached` (by name): tmux `#{session_attached}` — 0 =
   * detached, anything else = a client is attached. A MISSING entry is treated
   * as ATTACHED (conservative: unknown → never touch).
   */
  attachedMap: Readonly<Record<string, number | undefined>>;
  /** Per-session captured pane tail (by name) — scanned by detectThrottle. */
  paneTails: Readonly<Record<string, string | undefined>>;
  /**
   * Per-session stall corroboration (by name): true when the pane is an idle
   * shell OR its tail hash is unchanged since the previous pass. A MISSING entry
   * is treated as NOT stalled (conservative: unknown → assume the agent is busy,
   * never interrupt).
   */
  stalledMap: Readonly<Record<string, boolean | undefined>>;
  /** AIMD effective cap — at most this many sessions are resumed per pass. */
  cap: number;
  /** Max resume nudges before we give up on a session (advise only). */
  maxAttempts?: number;
  /** Backoff base/cap (ms) + injectable jitter, forwarded to jitteredBackoffMs. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  rand?: () => number;
};

/** Is `attached` value a DETACHED pane (session_attached === 0)? Strict. */
export function isDetached(attached: number | undefined): boolean {
  return attached === 0;
}

/** ms epoch from an ISO string or a number; NaN-safe (undefined → +Inf, sorts last). */
function toMs(v: string | number | undefined): number {
  if (v === undefined) return Number.POSITIVE_INFINITY;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Is a throttled session DUE for a nudge (now >= nextRetryAt)? Missing → due. */
export function isInteractiveResumeDue(
  prior: InteractiveThrottleInfo | undefined,
  nowMs: number,
): boolean {
  const at = prior?.nextRetryAt;
  if (at === undefined) return true;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return true;
  return nowMs >= ms;
}

/**
 * Minutes-until-retry label for an advisory (e.g. "retry in 3m" / "retry now").
 * Rounds UP so a sub-minute wait still reads as 1m. Pure, exported for tests.
 */
export function interactiveRetryLabel(
  prior: InteractiveThrottleInfo | undefined,
  nowMs: number,
): string {
  const at = prior?.nextRetryAt;
  if (at === undefined) return "retry now";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || ms <= nowMs) return "retry now";
  return `retry in ${Math.ceil((ms - nowMs) / 60_000)}m`;
}

/**
 * THE pure planner. Classify each session as throttled (a provider rate-limit
 * signature in its pane tail) and decide which DETACHED, stalled, due,
 * under-attempt-cap sessions to nudge this pass — at most `cap`, oldest-throttle
 * first. Returns the full throttled set (for advisories), the nudge plan, and one
 * advisory line per decision. NO IO — the caller supplies tails / attached /
 * stall / clock and persists the returned `next` bookkeeping.
 *
 * Decision order per session:
 *  1. detectThrottle(tail, type) — no signature ⇒ not throttled, ignored.
 *  2. ATTACHED (session_attached !== 0, or unknown) ⇒ advise only, NEVER nudge.
 *  3. NOT stalled (agent still working / unknown) ⇒ advise only, NEVER nudge.
 *  4. NOT due (within backoff window) ⇒ advise "retry in Xm", skip.
 *  5. attempts >= maxAttempts ⇒ advise "gave up", skip.
 *  6. else CANDIDATE — sorted oldest-throttle-first, take up to `cap`.
 */
export function planInteractiveResume(
  opts: PlanInteractiveResumeOpts,
): InteractiveResumePlan {
  const {
    sessions,
    now,
    throttleState,
    attachedMap,
    paneTails,
    stalledMap,
  } = opts;
  const maxAttempts = opts.maxAttempts ?? THROTTLE_MAX_ATTEMPTS;
  const baseMs = opts.backoffBaseMs ?? THROTTLE_BACKOFF_BASE_MS;
  const capMs = opts.backoffCapMs ?? THROTTLE_BACKOFF_CAP_MS;
  const rand = opts.rand ?? Math.random;
  const cap = opts.cap;

  const throttled: InteractiveThrottled[] = [];
  const advisories: string[] = [];
  // Candidates that PASSED every guard (detached + stalled + due + under cap):
  // we collect them with their ordering key, then sort + take up to `cap`.
  const candidates: Array<{
    session: InteractiveSession;
    signature?: string;
    prior: InteractiveThrottleInfo | undefined;
    orderKey: number;
    tieKey: number;
  }> = [];

  for (const s of sessions) {
    const tail = paneTails[s.name] ?? "";
    const verdict = detectThrottle(tail, s.type);
    if (!verdict.throttled) continue;

    const attached = !isDetached(attachedMap[s.name]);
    const stalled = stalledMap[s.name] === true;
    throttled.push({
      name: s.name,
      type: s.type,
      ...(verdict.signature !== undefined ? { signature: verdict.signature } : {}),
      attached,
      stalled,
    });

    const sig = verdict.signature ?? "rate-limited";
    if (attached) {
      // HARD guard — a human is on this pane. Detect + advise, NEVER touch.
      advisories.push(
        `[remote] ${s.name} (${s.type}) throttled (${sig}) — ATTACHED, not touching it (resume it yourself, or detach to let auto-resume nudge it)`,
      );
      continue;
    }
    if (!stalled) {
      // Signature present but the pane is still moving (or stall unknown) — the
      // agent likely recovered on its own. Advise only; do NOT interrupt.
      advisories.push(
        `[remote] ${s.name} (${s.type}) saw a rate-limit (${sig}) but is still active — leaving it alone`,
      );
      continue;
    }
    const prior = throttleState[s.name];
    if (!isInteractiveResumeDue(prior, now)) {
      advisories.push(
        `[remote] ${s.name} (${s.type}) throttled (${sig}) — backing off, ${interactiveRetryLabel(prior, now)}`,
      );
      continue;
    }
    const priorAttempts = prior?.attempts ?? 0;
    if (priorAttempts >= maxAttempts) {
      advisories.push(
        `[remote] ${s.name} (${s.type}) throttled (${sig}) — gave up after ${priorAttempts} resume attempt(s); resume it manually`,
      );
      continue;
    }
    candidates.push({
      session: s,
      ...(verdict.signature !== undefined ? { signature: verdict.signature } : {}),
      prior,
      // Oldest-throttle first: a session WITH prior bookkeeping orders by its
      // firstAt; a never-throttled-before session uses `now` (just entered).
      orderKey: prior ? toMs(prior.firstAt) : now,
      tieKey: toMs(s.startedAt),
    });
  }

  // Stagger: oldest throttle first, then oldest session, then name (stable).
  candidates.sort(
    (a, b) =>
      a.orderKey - b.orderKey ||
      a.tieKey - b.tieKey ||
      a.session.name.localeCompare(b.session.name),
  );

  const toResume: InteractiveResume[] = [];
  const limit = cap > 0 ? cap : 0;
  for (const c of candidates) {
    if (toResume.length >= limit) {
      advisories.push(
        `[remote] ${c.session.name} (${c.session.type}) throttled — deferred (AIMD cap ${limit} reached this pass)`,
      );
      continue;
    }
    const priorAttempts = c.prior?.attempts ?? 0;
    const nowIso = new Date(now).toISOString();
    // Backoff for the NEXT retry uses the post-nudge attempt count.
    const delay = jitteredBackoffMs(priorAttempts + 1, baseMs, capMs, rand);
    const next: InteractiveThrottleInfo = {
      attempts: priorAttempts + 1,
      firstAt: c.prior?.firstAt ?? nowIso,
      nextRetryAt: new Date(now + delay).toISOString(),
      ...(c.signature !== undefined ? { lastSignature: c.signature } : {}),
    };
    toResume.push({
      name: c.session.name,
      type: c.session.type,
      ...(c.signature !== undefined ? { signature: c.signature } : {}),
      attempt: priorAttempts,
      next,
    });
    advisories.push(
      `[remote] ${c.session.name} (${c.session.type}) throttled (${c.signature ?? "rate-limited"}) — resuming (detached, attempt ${priorAttempts + 1}/${maxAttempts})`,
    );
  }

  return { throttled, toResume, advisories };
}

/**
 * The MINIMAL "continue" nudge to wake a stalled agent CLI in its pane, by type.
 * Pure, exported for tests. The argv is sent via tmux `send-keys` as a SINGLE
 * literal token followed by Enter — never a shell string, never multiple keys
 * the agent could misread. The nudge is the most benign "carry on" each CLI
 * understands when sitting at its prompt after a transient error:
 *  - claude / agy: the word `continue` (a plain message at the prompt).
 *  - codex:        `continue` likewise.
 *
 * All three take the SAME literal because, for an INTERACTIVE pane sitting idle
 * after a rate-limit, the safe universal action is to type a short "continue"
 * message and submit it — anything fancier risks being interpreted as a command.
 */
export function interactiveResumeNudge(_type: DelegateType): string {
  return "continue";
}
