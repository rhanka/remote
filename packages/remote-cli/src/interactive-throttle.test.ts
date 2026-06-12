import { describe, expect, it } from "vitest";

import {
  interactiveResumeNudge,
  interactiveRetryLabel,
  isDetached,
  isInteractiveResumeDue,
  planInteractiveResume,
  type InteractiveSession,
  type InteractiveThrottleInfo,
  type PlanInteractiveResumeOpts,
} from "./interactive-throttle.js";

// The canonical claude transient rate-limit line (see throttle-signatures.ts).
const CLAUDE_LIMIT =
  "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
const CODEX_LIMIT = "stream error: 429 rate limit reached";
const CLEAN_TAIL = "thinking about your request...\nhere is the plan:\n1. do X";

const NOW = Date.parse("2026-06-12T12:00:00.000Z");

function session(
  name: string,
  type: InteractiveSession["type"] = "claude",
  startedAt: string | number = NOW,
): InteractiveSession {
  return { name, type, startedAt };
}

/** Build opts with sensible all-detached / all-stalled / no-prior defaults. */
function opts(
  sessions: InteractiveSession[],
  over: Partial<PlanInteractiveResumeOpts> = {},
): PlanInteractiveResumeOpts {
  const attachedMap: Record<string, number> = {};
  const stalledMap: Record<string, boolean> = {};
  const paneTails: Record<string, string> = {};
  for (const s of sessions) {
    attachedMap[s.name] = 0; // detached
    stalledMap[s.name] = true; // stalled
    paneTails[s.name] = s.type === "codex" ? CODEX_LIMIT : CLAUDE_LIMIT;
  }
  return {
    sessions,
    now: NOW,
    throttleState: {},
    attachedMap,
    paneTails,
    stalledMap,
    cap: 16,
    rand: () => 0.5, // pin the jitter
    ...over,
  };
}

describe("isDetached (strict session_attached === 0)", () => {
  it("0 is detached; anything else (incl. undefined) is attached", () => {
    expect(isDetached(0)).toBe(true);
    expect(isDetached(1)).toBe(false);
    expect(isDetached(2)).toBe(false);
    expect(isDetached(undefined)).toBe(false);
  });
});

describe("planInteractiveResume — classification", () => {
  it("a clean pane (no rate-limit signature) is not throttled at all", () => {
    const plan = planInteractiveResume(
      opts([session("remote-a")], {
        paneTails: { "remote-a": CLEAN_TAIL },
      }),
    );
    expect(plan.throttled).toHaveLength(0);
    expect(plan.toResume).toHaveLength(0);
  });

  it("a throttled, detached, stalled, due session is resumed", () => {
    const plan = planInteractiveResume(opts([session("remote-a")]));
    expect(plan.throttled).toHaveLength(1);
    expect(plan.throttled[0]).toMatchObject({
      name: "remote-a",
      attached: false,
      stalled: true,
    });
    expect(plan.toResume.map((r) => r.name)).toEqual(["remote-a"]);
    expect(plan.toResume[0]!.attempt).toBe(0);
    expect(plan.toResume[0]!.next.attempts).toBe(1);
  });

  it("codex tail uses the codex signature table", () => {
    const plan = planInteractiveResume(opts([session("remote-c", "codex")]));
    expect(plan.toResume.map((r) => r.name)).toEqual(["remote-c"]);
    expect(plan.toResume[0]!.type).toBe("codex");
  });
});

describe("planInteractiveResume — ATTACHED guard (NEVER touch)", () => {
  it("an attached throttled pane is classified but NEVER resumed", () => {
    const plan = planInteractiveResume(
      opts([session("remote-a")], { attachedMap: { "remote-a": 1 } }),
    );
    expect(plan.throttled).toHaveLength(1);
    expect(plan.throttled[0]!.attached).toBe(true);
    expect(plan.toResume).toHaveLength(0);
    expect(plan.advisories.join("\n")).toMatch(/ATTACHED, not touching/i);
  });

  it("an UNKNOWN attached value is treated as attached (conservative, never touch)", () => {
    const plan = planInteractiveResume(
      opts([session("remote-a")], { attachedMap: {} }),
    );
    expect(plan.toResume).toHaveLength(0);
    expect(plan.throttled[0]!.attached).toBe(true);
  });
});

describe("planInteractiveResume — STALL corroboration", () => {
  it("a throttle signature without stall (agent still active) is NOT resumed", () => {
    const plan = planInteractiveResume(
      opts([session("remote-a")], { stalledMap: { "remote-a": false } }),
    );
    expect(plan.throttled).toHaveLength(1);
    expect(plan.throttled[0]!.stalled).toBe(false);
    expect(plan.toResume).toHaveLength(0);
    expect(plan.advisories.join("\n")).toMatch(/still active/i);
  });

  it("an UNKNOWN stall value is treated as not stalled (conservative)", () => {
    const plan = planInteractiveResume(
      opts([session("remote-a")], { stalledMap: {} }),
    );
    expect(plan.toResume).toHaveLength(0);
  });
});

describe("planInteractiveResume — backoff / due", () => {
  it("a session within its backoff window is NOT resumed, advises retry-in", () => {
    const prior: InteractiveThrottleInfo = {
      attempts: 1,
      firstAt: new Date(NOW - 60_000).toISOString(),
      nextRetryAt: new Date(NOW + 5 * 60_000).toISOString(), // 5m future
    };
    const plan = planInteractiveResume(
      opts([session("remote-a")], { throttleState: { "remote-a": prior } }),
    );
    expect(plan.toResume).toHaveLength(0);
    expect(plan.advisories.join("\n")).toMatch(/retry in 5m/);
  });

  it("a session past its nextRetryAt IS resumed and bumps attempts", () => {
    const prior: InteractiveThrottleInfo = {
      attempts: 2,
      firstAt: new Date(NOW - 600_000).toISOString(),
      nextRetryAt: new Date(NOW - 1000).toISOString(), // 1s past
    };
    const plan = planInteractiveResume(
      opts([session("remote-a")], { throttleState: { "remote-a": prior } }),
    );
    expect(plan.toResume).toHaveLength(1);
    expect(plan.toResume[0]!.attempt).toBe(2);
    expect(plan.toResume[0]!.next.attempts).toBe(3);
    // firstAt is preserved across passes.
    expect(plan.toResume[0]!.next.firstAt).toBe(prior.firstAt);
    // nextRetryAt is rescheduled into the future.
    expect(Date.parse(plan.toResume[0]!.next.nextRetryAt)).toBeGreaterThan(NOW);
  });
});

describe("planInteractiveResume — max attempts → give up", () => {
  it("a session at the attempt cap is advised, never resumed", () => {
    const prior: InteractiveThrottleInfo = {
      attempts: 3,
      firstAt: new Date(NOW - 600_000).toISOString(),
      nextRetryAt: new Date(NOW - 1).toISOString(),
    };
    const plan = planInteractiveResume(
      opts([session("remote-a")], {
        throttleState: { "remote-a": prior },
        maxAttempts: 3,
      }),
    );
    expect(plan.toResume).toHaveLength(0);
    expect(plan.advisories.join("\n")).toMatch(/gave up after 3/i);
  });
});

describe("planInteractiveResume — AIMD cap (staggered, oldest-first)", () => {
  it("resumes at most `cap` sessions per pass, oldest throttle first", () => {
    const sessions = [
      session("remote-new"),
      session("remote-old"),
      session("remote-mid"),
    ];
    const throttleState: Record<string, InteractiveThrottleInfo> = {
      "remote-new": {
        attempts: 1,
        firstAt: new Date(NOW - 10_000).toISOString(),
        nextRetryAt: new Date(NOW - 1).toISOString(),
      },
      "remote-old": {
        attempts: 1,
        firstAt: new Date(NOW - 900_000).toISOString(), // oldest throttle
        nextRetryAt: new Date(NOW - 1).toISOString(),
      },
      "remote-mid": {
        attempts: 1,
        firstAt: new Date(NOW - 300_000).toISOString(),
        nextRetryAt: new Date(NOW - 1).toISOString(),
      },
    };
    const plan = planInteractiveResume(
      opts(sessions, { throttleState, cap: 2 }),
    );
    // Only 2 resumed, oldest-throttle first.
    expect(plan.toResume.map((r) => r.name)).toEqual([
      "remote-old",
      "remote-mid",
    ]);
    expect(plan.advisories.join("\n")).toMatch(/deferred \(AIMD cap 2/);
  });

  it("cap 0 resumes nothing but still classifies + advises", () => {
    const plan = planInteractiveResume(opts([session("remote-a")], { cap: 0 }));
    expect(plan.toResume).toHaveLength(0);
    expect(plan.throttled).toHaveLength(1);
  });

  it("a never-throttled-before session orders by `now` (after older throttles)", () => {
    const sessions = [session("remote-fresh"), session("remote-old")];
    const throttleState: Record<string, InteractiveThrottleInfo> = {
      "remote-old": {
        attempts: 1,
        firstAt: new Date(NOW - 900_000).toISOString(),
        nextRetryAt: new Date(NOW - 1).toISOString(),
      },
    };
    const plan = planInteractiveResume(
      opts(sessions, { throttleState, cap: 1 }),
    );
    expect(plan.toResume.map((r) => r.name)).toEqual(["remote-old"]);
  });
});

describe("planInteractiveResume — mixed fleet (the realistic case)", () => {
  it("classifies attached/active/clean correctly and only nudges the safe ones", () => {
    const sessions = [
      session("remote-attached"),
      session("remote-active"),
      session("remote-clean"),
      session("remote-stuck"),
    ];
    const o = opts(sessions, {
      attachedMap: {
        "remote-attached": 1,
        "remote-active": 0,
        "remote-clean": 0,
        "remote-stuck": 0,
      },
      stalledMap: {
        "remote-attached": true,
        "remote-active": false,
        "remote-clean": true,
        "remote-stuck": true,
      },
      paneTails: {
        "remote-attached": CLAUDE_LIMIT,
        "remote-active": CLAUDE_LIMIT,
        "remote-clean": CLEAN_TAIL,
        "remote-stuck": CLAUDE_LIMIT,
      },
    });
    const plan = planInteractiveResume(o);
    // clean isn't throttled; the other three are.
    expect(plan.throttled.map((t) => t.name).sort()).toEqual([
      "remote-active",
      "remote-attached",
      "remote-stuck",
    ]);
    // Only the detached + stalled + due one is nudged.
    expect(plan.toResume.map((r) => r.name)).toEqual(["remote-stuck"]);
  });
});

describe("isInteractiveResumeDue / interactiveRetryLabel", () => {
  it("missing bookkeeping is due now", () => {
    expect(isInteractiveResumeDue(undefined, NOW)).toBe(true);
    expect(interactiveRetryLabel(undefined, NOW)).toBe("retry now");
  });

  it("future nextRetryAt is not due; label rounds up", () => {
    const prior: InteractiveThrottleInfo = {
      attempts: 1,
      firstAt: new Date(NOW).toISOString(),
      nextRetryAt: new Date(NOW + 90_000).toISOString(), // 1.5 min
    };
    expect(isInteractiveResumeDue(prior, NOW)).toBe(false);
    expect(interactiveRetryLabel(prior, NOW)).toBe("retry in 2m");
  });

  it("unparseable nextRetryAt is treated as due (never strand)", () => {
    const prior = {
      attempts: 1,
      firstAt: "x",
      nextRetryAt: "not-a-date",
    } as InteractiveThrottleInfo;
    expect(isInteractiveResumeDue(prior, NOW)).toBe(true);
  });
});

describe("interactiveResumeNudge (argv-safe continue token)", () => {
  it("returns a single literal `continue` for every type", () => {
    expect(interactiveResumeNudge("claude")).toBe("continue");
    expect(interactiveResumeNudge("codex")).toBe("continue");
    expect(interactiveResumeNudge("agy")).toBe("continue");
  });
});
