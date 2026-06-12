import { describe, expect, it } from "vitest";

import { deadPodAdvisory, isExecutablePhase } from "./pod-liveness.js";

/**
 * Pure-decision tests for the watch-loop dead-pod guard (the executor `podPhase`
 * shells out to kubectl and is NOT unit-tested here — these never shell out).
 */

describe("isExecutablePhase — only Running is execable", () => {
  it("Running → true", () => {
    expect(isExecutablePhase("Running")).toBe(true);
  });

  it("Failed (Evicted/OOM, exit 137) → false", () => {
    expect(isExecutablePhase("Failed")).toBe(false);
  });

  it("Succeeded (completed) → false", () => {
    expect(isExecutablePhase("Succeeded")).toBe(false);
  });

  it("Pending → false (no container to exec yet)", () => {
    expect(isExecutablePhase("Pending")).toBe(false);
  });

  it("Unknown → false", () => {
    expect(isExecutablePhase("Unknown")).toBe(false);
  });

  it("empty string (NotFound / unreadable) → false", () => {
    expect(isExecutablePhase("")).toBe(false);
  });

  it("undefined → false", () => {
    expect(isExecutablePhase(undefined)).toBe(false);
  });

  it("any future/unexpected phase → false (closed default)", () => {
    expect(isExecutablePhase("Terminating")).toBe(false);
  });
});

describe("deadPodAdvisory — one concise, secret-free line", () => {
  it("names the session + the phase", () => {
    expect(deadPodAdvisory("sess-944o2ybf", "Failed")).toBe(
      "[remote] session sess-944o2ybf: pod Failed — skipping (evicted/dead)",
    );
  });

  it('empty phase reads as "gone" (NotFound/unreadable)', () => {
    expect(deadPodAdvisory("sess-x", "")).toContain("pod gone");
  });
});
