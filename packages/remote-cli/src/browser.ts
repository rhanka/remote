/**
 * `remote browser open <sessionId>` — WP7 noVNC headful browser-in-pod.
 *
 * One command to open the headful browser view for a session so the user can
 * complete a 2FA / login challenge visually. The heavy lifting (spawning the
 * Xvfb+Chromium+x11vnc+websockify+noVNC sidecar) happens IN the Pod via the
 * browser-bridge; this CLI surface is the user's entry point:
 *
 *   1. enforce the uat-exposure-policy locally (deny early with a reason);
 *   2. mint the per-session noVNC token + build the forwardable noVNC URL;
 *   3. print the exact `remote forward <id> 6080` command and the URL to open.
 *
 * The actual port-forward is delegated to the existing `remote forward`
 * transport (forward.ts) — we don't duplicate kubectl wiring. The token is the
 * only sensitive value; it is printed ONCE to the user's own terminal (so they
 * can open the gated URL) and never logged elsewhere. The pure builder below is
 * unit-tested; the action wiring lives in index.ts.
 */

import {
  buildForwardCommand,
  buildNoVncUrl,
  evaluateExposure,
  mintNoVncToken,
  NOVNC_POD_PORT,
  type ExposureRequester,
  type RandomBytes,
} from "./browser-bridge-local.js";
import type { UatExposurePolicy } from "./protocol-local.js";

export type BrowserOpenPlan =
  | {
      readonly ok: true;
      readonly podPort: number;
      readonly forwardCommand: string;
      readonly url: string;
      /** Human-facing multi-line instructions (token only in the URL). */
      readonly instructions: string;
    }
  | { readonly ok: false; readonly reason: string };

export type BuildBrowserOpenPlanOptions = {
  readonly sessionId: string;
  /** Default session-private — only the owner, token-gated. */
  readonly exposurePolicy?: UatExposurePolicy;
  /** Default session-owner (the user running the CLI owns the session). */
  readonly requester?: ExposureRequester;
  /** Local port the user will bind the forward to (optional). */
  readonly localPort?: number;
  /** Interactive (drive the 2FA) — default true. */
  readonly interactive?: boolean;
  /** Route TTL in ms (only required by the public-expiring policy). */
  readonly ttlMs?: number;
  /** Injectable RNG for the token (tests). */
  readonly rng?: RandomBytes;
};

/**
 * Build the open plan: policy-gate, then the forward command + noVNC URL the
 * user runs/opens. Pure (token from the injected RNG) so the allow/deny and the
 * exact command/URL are unit-tested without a cluster.
 */
export function buildBrowserOpenPlan(
  opts: BuildBrowserOpenPlanOptions,
): BrowserOpenPlan {
  const policy: UatExposurePolicy = opts.exposurePolicy ?? "session-private";
  const requester: ExposureRequester = opts.requester ?? "session-owner";
  const interactive = opts.interactive ?? true;

  const decision = evaluateExposure({
    policy,
    requester,
    hasToken: true, // we always mint a token below
    ...(policy === "public-expiring" && opts.ttlMs !== undefined
      ? { expiresInMs: opts.ttlMs }
      : {}),
  });
  if (!decision.allowed) {
    return { ok: false, reason: decision.reason };
  }

  const token = mintNoVncToken(opts.rng);
  const forwardCommand = buildForwardCommand(opts.sessionId, opts.localPort);
  const url = buildNoVncUrl({
    token,
    interactive,
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
  });

  const instructions =
    `[remote] headful browser for ${opts.sessionId} (noVNC, ${policy})\n` +
    `[remote] 1. open the port-forward (foreground, Ctrl-C to stop):\n` +
    `           ${forwardCommand}\n` +
    `[remote] 2. then open this URL in your browser:\n` +
    `           ${url}\n` +
    `[remote] complete the 2FA/login in the desktop, then stop the forward.\n`;

  return {
    ok: true,
    podPort: NOVNC_POD_PORT,
    forwardCommand,
    url,
    instructions,
  };
}
