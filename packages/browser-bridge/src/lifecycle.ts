/**
 * Headful browser-session lifecycle state machine.
 *
 * A headful browser session inside the Pod is opt-in and resource-guarded: it
 * is only started when the user requests it, and torn down when done. The valid
 * states and transitions are modelled here as a pure state machine so the
 * orchestrating bridge (bridge.ts) never spawns/kills a container from an
 * illegal state, and so the transition rules are exhaustively unit-tested
 * without launching X/Chromium/k8s.
 *
 *   idle ──start──▶ starting ──ready──▶ running ──stop──▶ stopping ──stopped──▶ stopped
 *     │                  │                  │                  │
 *     │                  └──fail──▶ failed ◀┘                  │
 *     └◀───────────────── reset ───────────── stopped/failed ──┘
 *
 * `failed` and `stopped` are terminal-until-reset: the bridge `reset`s back to
 * `idle` before a fresh start (a Pod-restart, a new request).
 */

export type BrowserSessionState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type BrowserSessionEvent =
  | "start" // user requested a headful browser
  | "ready" // Xvfb+Chromium+x11vnc+websockify all up, port listening
  | "stop" // user (or expiry) requested teardown
  | "stopped" // teardown confirmed
  | "fail" // any startup/runtime failure
  | "reset"; // back to idle (e.g. before re-requesting)

const TRANSITIONS: Readonly<
  Record<
    BrowserSessionState,
    Partial<Record<BrowserSessionEvent, BrowserSessionState>>
  >
> = {
  idle: { start: "starting" },
  starting: { ready: "running", fail: "failed", stop: "stopping" },
  running: { stop: "stopping", fail: "failed" },
  stopping: { stopped: "stopped", fail: "failed" },
  stopped: { reset: "idle" },
  failed: { reset: "idle" },
};

/** The state a given event leads to, or undefined when the event is illegal. */
export function nextBrowserState(
  state: BrowserSessionState,
  event: BrowserSessionEvent,
): BrowserSessionState | undefined {
  return TRANSITIONS[state][event];
}

/** Whether an event is legal from the current state. */
export function canTransition(
  state: BrowserSessionState,
  event: BrowserSessionEvent,
): boolean {
  return nextBrowserState(state, event) !== undefined;
}

/** Terminal states (no further progress without an explicit reset). */
export function isTerminal(state: BrowserSessionState): boolean {
  return state === "stopped" || state === "failed";
}

/** Live = the browser is up (or coming up) and the port may be forwarded. */
export function isLive(state: BrowserSessionState): boolean {
  return state === "starting" || state === "running";
}
