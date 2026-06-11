/**
 * uat-exposure-policy enforcement.
 *
 * The protocol defines three exposure policies for a UAT route (the noVNC
 * endpoint is one such route):
 *   - "operator-only"    — only an operator (control-plane admin) may reach it.
 *   - "session-private"  — only the user who owns the session may reach it.
 *   - "public-expiring"  — anyone with the URL may reach it, until it expires.
 *
 * For headful 2FA the route MUST carry a session-private (or operator) channel:
 * a person is about to type real credentials into an authenticated site, so the
 * endpoint can never be world-open without an explicit, expiry-bounded opt-in.
 *
 * This module is the single allow/deny gate. It is pure (no I/O) so the
 * allow/deny matrix is fully unit-tested. The bridge calls `evaluateExposure`
 * before constructing any forwardable URL; on deny it returns a clear reason and
 * the bridge never starts/exposes the browser.
 */

import type { UatExposurePolicy } from "@sentropic/remote-protocol";

/** Who is asking to open the forwarded browser view. */
export type ExposureRequester = "operator" | "session-owner" | "anonymous";

export type ExposureRequest = {
  /** Policy attached to the session / requested for this route. */
  readonly policy: UatExposurePolicy;
  /** Identity of the caller asking to expose the browser. */
  readonly requester: ExposureRequester;
  /**
   * Whether a per-session access token is present on the route. Required for
   * any policy that is not operator-only — a session-private or public route
   * with no token would be reachable by anyone who can hit the forwarded port.
   */
  readonly hasToken: boolean;
  /**
   * For "public-expiring": the route must carry an expiry. Provided as a
   * millisecond TTL (> 0) when known; undefined/<=0 is a deny.
   */
  readonly expiresInMs?: number;
};

export type ExposureDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const ALLOW: ExposureDecision = { allowed: true };
const deny = (reason: string): ExposureDecision => ({ allowed: false, reason });

/**
 * Allow/deny matrix for exposing the headful browser route.
 *
 *   operator-only     → only "operator". (token optional: operator channel is
 *                       already privileged; we still recommend one but do not
 *                       hard-require it for the operator path.)
 *   session-private   → "operator" or "session-owner", AND a token MUST be
 *                       present. "anonymous" is denied.
 *   public-expiring   → any requester, AND a token MUST be present AND a finite
 *                       positive expiry MUST be set (no open-ended public route).
 */
export function evaluateExposure(req: ExposureRequest): ExposureDecision {
  switch (req.policy) {
    case "operator-only":
      return req.requester === "operator"
        ? ALLOW
        : deny(
            `policy "operator-only" forbids requester "${req.requester}" — only an operator may expose this browser`,
          );

    case "session-private":
      if (req.requester === "anonymous") {
        return deny(
          'policy "session-private" forbids an anonymous requester — only the session owner or an operator may expose this browser',
        );
      }
      if (!req.hasToken) {
        return deny(
          'policy "session-private" requires a per-session access token on the route (none present)',
        );
      }
      return ALLOW;

    case "public-expiring":
      if (!req.hasToken) {
        return deny(
          'policy "public-expiring" requires a per-session access token on the route (none present)',
        );
      }
      if (req.expiresInMs === undefined || req.expiresInMs <= 0) {
        return deny(
          'policy "public-expiring" requires a finite positive expiry (expiresInMs) — refusing an open-ended public route',
        );
      }
      return ALLOW;

    default: {
      // Exhaustiveness guard: a new policy value must be handled explicitly.
      const exhaustive: never = req.policy;
      return deny(`unknown exposure policy ${JSON.stringify(exhaustive)}`);
    }
  }
}
