/**
 * Headful browser-in-pod bridge — the real lifecycle (replaces the one-line
 * stub). It orchestrates:
 *
 *   1. uat-exposure-policy enforcement (policy.ts) — deny early with a reason.
 *   2. a per-session noVNC token (token.ts) — so the forwarded URL isn't open.
 *   3. the start/ready/stop state machine (lifecycle.ts).
 *   4. the forwardable noVNC URL the user opens (forward-url.ts).
 *   5. the browser.* / uat.* protocol payloads (protocol.ts) the control-plane
 *      broadcasts.
 *
 * The PROCESS/CONTAINER spawning sits behind an injectable `BrowserSpawner`
 * seam: in the Pod it shells the browser sidecar (Xvfb + Chromium + x11vnc +
 * websockify + noVNC); in tests it is a fake, so no X/Chromium/k8s ever runs.
 *
 * SECURITY: the noVNC token is held in memory and returned only in the
 * forwardable URL. It is never put into a protocol event, never logged. Default
 * exposure is interactive (the user must DRIVE the 2FA), session-private (only
 * the owner), token-gated, and TTL-bounded.
 */

import {
  isLive,
  nextBrowserState,
  type BrowserSessionEvent,
  type BrowserSessionState,
} from "./lifecycle.js";
import { evaluateExposure, type ExposureRequester } from "./policy.js";
import {
  buildForwardCommand,
  buildNoVncUrl,
  DEFAULT_DISPLAY,
  DEFAULT_GEOMETRY,
  NOVNC_POD_PORT,
} from "./forward-url.js";
import { mintNoVncToken, type RandomBytes } from "./token.js";
import {
  buildBrowserStarted,
  buildUatRouteCreated,
  buildUatRouteExpired,
} from "./protocol.js";
import type {
  BrowserStarted,
  UatExposurePolicy,
  UatRouteCreated,
  UatRouteExpired,
} from "@sentropic/remote-protocol";

/** A running headful-browser process group inside the Pod. */
export type BrowserHandle = {
  /** Opaque id of the spawned process group (for stop/inspect). */
  readonly pid: string;
};

/** Geometry/port knobs handed to the spawner (reversible defaults). */
export type BrowserSpawnConfig = {
  readonly display: string;
  readonly geometry: string;
  readonly podPort: number;
  /** The websockify token gate — only connections carrying it are accepted. */
  readonly token: string;
  /** Interactive (user can click/type, for 2FA) vs view-only. */
  readonly interactive: boolean;
};

/**
 * The impure seam. The real implementation (in the Pod / session-agent) spawns
 * the browser sidecar entrypoint; tests inject a fake. NEVER builds a shell
 * string from untrusted data — the token is the only dynamic value and it is
 * our own minted hex, passed as a discrete config field (the entrypoint reads
 * it from an env/argv slot, never interpolated into `bash -lc`).
 */
export interface BrowserSpawner {
  spawn(config: BrowserSpawnConfig): Promise<BrowserHandle>;
  kill(handle: BrowserHandle): Promise<void>;
}

export type StartBrowserRequest = {
  readonly sessionId: string;
  readonly exposurePolicy: UatExposurePolicy;
  readonly requester: ExposureRequester;
  /** Route lifetime in ms; also the public-expiring policy's required expiry. */
  readonly ttlMs: number;
  /** Default true — WP7 is a human completing a 2FA/login challenge. */
  readonly interactive?: boolean;
  /** Local port the user's `remote forward` landed on (for the returned URL). */
  readonly localPort?: number;
};

export type StartBrowserResult =
  | {
      readonly ok: true;
      /** Forwardable URL the user opens (carries the token + interactive flag). */
      readonly url: string;
      /** The `remote forward …` command the user runs to open the forward. */
      readonly forwardCommand: string;
      readonly podPort: number;
      readonly browserId: string;
      readonly routeId: string;
      readonly expiresAt: string;
      /** browser.started event payload (no secrets). */
      readonly started: BrowserStarted;
      /** uat.route.created event payload (no secrets). */
      readonly routeCreated: UatRouteCreated;
    }
  | { readonly ok: false; readonly reason: string };

export type BrowserStatus = {
  readonly state: BrowserSessionState;
  readonly browserId?: string;
  readonly routeId?: string;
  readonly podPort: number;
  readonly interactive: boolean;
  readonly expiresAt?: string;
  /** Whether a token is set (NEVER the token value itself). */
  readonly tokenPresent: boolean;
};

export type BridgeDeps = {
  readonly spawner: BrowserSpawner;
  /** Injectable clock (ms epoch) — defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable RNG for the token — defaults to webcrypto. */
  readonly rng?: RandomBytes;
  /** Injectable id factory — defaults to crypto.randomUUID. */
  readonly newId?: (prefix: string) => string;
};

const defaultNewId = (prefix: string): string =>
  `${prefix}-${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * One headful browser session bound to one session Pod. Single-instance per
 * Pod by design (the sidecar binds one fixed port; a second concurrent headful
 * browser would need a second display/port — out of scope for 2FA).
 */
export class HeadfulBrowserBridge {
  private state: BrowserSessionState = "idle";
  private token: string | undefined;
  private handle: BrowserHandle | undefined;
  private browserId: string | undefined;
  private routeId: string | undefined;
  private expiresAt: string | undefined;
  private interactive = true;

  private readonly spawner: BrowserSpawner;
  private readonly now: () => number;
  private readonly rng: RandomBytes | undefined;
  private readonly newId: (prefix: string) => string;

  constructor(deps: BridgeDeps) {
    this.spawner = deps.spawner;
    this.now = deps.now ?? Date.now;
    this.rng = deps.rng;
    this.newId = deps.newId ?? defaultNewId;
  }

  /** Apply a lifecycle event; throws on an illegal transition (programmer bug). */
  private transition(event: BrowserSessionEvent): void {
    const next = nextBrowserState(this.state, event);
    if (next === undefined) {
      throw new Error(
        `illegal browser lifecycle transition: "${event}" from "${this.state}"`,
      );
    }
    this.state = next;
  }

  /**
   * Request + start a headful browser session. Enforces the exposure policy
   * FIRST (deny → never spawns), then mints a token, spawns the sidecar, and
   * returns the forwardable URL plus the browser.started / uat.route.created
   * payloads. Idempotency: a second start while already live is rejected.
   */
  async start(req: StartBrowserRequest): Promise<StartBrowserResult> {
    if (isLive(this.state)) {
      return {
        ok: false,
        reason: `a browser session is already ${this.state} for this pod (stop it first)`,
      };
    }
    // From a terminal state, reset back to idle before a fresh start.
    if (this.state === "stopped" || this.state === "failed") {
      this.transition("reset");
    }

    const token = mintNoVncToken(this.rng);

    const decision = evaluateExposure({
      policy: req.exposurePolicy,
      requester: req.requester,
      hasToken: true, // we always mint a token
      ...(req.exposurePolicy === "public-expiring"
        ? { expiresInMs: req.ttlMs }
        : {}),
    });
    if (!decision.allowed) {
      // Do not spawn, do not change state past idle.
      return { ok: false, reason: decision.reason };
    }

    const interactive = req.interactive ?? true;
    this.transition("start");
    let handle: BrowserHandle;
    try {
      handle = await this.spawner.spawn({
        display: DEFAULT_DISPLAY,
        geometry: DEFAULT_GEOMETRY,
        podPort: NOVNC_POD_PORT,
        token,
        interactive,
      });
    } catch (err) {
      this.transition("fail");
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `failed to start headful browser: ${msg}` };
    }

    this.transition("ready");
    this.token = token;
    this.handle = handle;
    this.interactive = interactive;
    this.browserId = this.newId("br");
    this.routeId = this.newId("uat");
    this.expiresAt = new Date(this.now() + req.ttlMs).toISOString();

    const url = buildNoVncUrl({
      token,
      interactive,
      ...(req.localPort !== undefined ? { localPort: req.localPort } : {}),
    });

    const started = buildBrowserStarted({
      browserId: this.browserId,
      metadata: { interactive, display: DEFAULT_DISPLAY },
    });
    const routeCreated = buildUatRouteCreated({
      routeId: this.routeId,
      url,
      port: NOVNC_POD_PORT,
      expiresAt: this.expiresAt,
      exposurePolicy: req.exposurePolicy,
    });

    return {
      ok: true,
      url,
      forwardCommand: buildForwardCommand(req.sessionId, req.localPort),
      podPort: NOVNC_POD_PORT,
      browserId: this.browserId,
      routeId: this.routeId,
      expiresAt: this.expiresAt,
      started,
      routeCreated,
    };
  }

  /**
   * Stop the running browser and tear down the route. Idempotent: stopping an
   * already-stopped/idle bridge is a no-op that still reports the route-expired
   * payload when a route existed. Returns the uat.route.expired payload (or
   * undefined when there was no live route).
   */
  async stop(): Promise<UatRouteExpired | undefined> {
    if (!isLive(this.state)) {
      return undefined;
    }
    this.transition("stop");
    if (this.handle) {
      try {
        await this.spawner.kill(this.handle);
      } catch {
        // Best-effort teardown: even if kill reports an error we still mark the
        // route expired so the user/control-plane stop forwarding to it.
      }
    }
    this.transition("stopped");
    const routeId = this.routeId;
    const expiredAt = new Date(this.now()).toISOString();
    // Clear secrets/handles.
    this.token = undefined;
    this.handle = undefined;
    this.browserId = undefined;
    this.routeId = undefined;
    this.expiresAt = undefined;
    return routeId ? buildUatRouteExpired({ routeId, expiredAt }) : undefined;
  }

  /** Current status — never exposes the token value (only its presence). */
  status(): BrowserStatus {
    return {
      state: this.state,
      ...(this.browserId ? { browserId: this.browserId } : {}),
      ...(this.routeId ? { routeId: this.routeId } : {}),
      podPort: NOVNC_POD_PORT,
      interactive: this.interactive,
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      tokenPresent: this.token !== undefined,
    };
  }
}
