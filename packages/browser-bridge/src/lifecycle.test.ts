import { describe, expect, it } from "vitest";

import {
  canTransition,
  isLive,
  isTerminal,
  nextBrowserState,
  type BrowserSessionEvent,
  type BrowserSessionState,
} from "./lifecycle.js";

describe("browser lifecycle state machine", () => {
  it("walks the happy path idle→starting→running→stopping→stopped", () => {
    let s: BrowserSessionState = "idle";
    s = nextBrowserState(s, "start")!;
    expect(s).toBe("starting");
    s = nextBrowserState(s, "ready")!;
    expect(s).toBe("running");
    s = nextBrowserState(s, "stop")!;
    expect(s).toBe("stopping");
    s = nextBrowserState(s, "stopped")!;
    expect(s).toBe("stopped");
  });

  it("can fail from starting/running/stopping", () => {
    for (const from of ["starting", "running", "stopping"] as const) {
      expect(nextBrowserState(from, "fail")).toBe("failed");
    }
  });

  it("resets terminal states back to idle", () => {
    expect(nextBrowserState("stopped", "reset")).toBe("idle");
    expect(nextBrowserState("failed", "reset")).toBe("idle");
  });

  it("rejects illegal transitions (undefined)", () => {
    expect(nextBrowserState("idle", "ready")).toBeUndefined();
    expect(nextBrowserState("idle", "stop")).toBeUndefined();
    expect(nextBrowserState("running", "start")).toBeUndefined();
    expect(nextBrowserState("stopped", "start")).toBeUndefined();
  });

  it("canTransition mirrors nextBrowserState", () => {
    const states: BrowserSessionState[] = [
      "idle",
      "starting",
      "running",
      "stopping",
      "stopped",
      "failed",
    ];
    const events: BrowserSessionEvent[] = [
      "start",
      "ready",
      "stop",
      "stopped",
      "fail",
      "reset",
    ];
    for (const s of states) {
      for (const e of events) {
        expect(canTransition(s, e)).toBe(nextBrowserState(s, e) !== undefined);
      }
    }
  });

  it("classifies terminal and live states", () => {
    expect(isTerminal("stopped")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isLive("starting")).toBe(true);
    expect(isLive("running")).toBe(true);
    expect(isLive("idle")).toBe(false);
    expect(isLive("stopped")).toBe(false);
  });
});
