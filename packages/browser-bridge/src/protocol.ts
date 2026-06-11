/**
 * `browser.*` / `uat.*` protocol message build + parse helpers.
 *
 * The protocol package defines the EVENT payload SHAPES (browser-started,
 * browser-navigated, browser-2fa-request, browser-user-takeover-*,
 * browser-sensitive-action-request, uat-route-created, uat-route-expired) and
 * their JSON Schemas. This module builds well-formed payloads of those shapes
 * from the bridge's runtime state, and parses/narrows inbound payloads (e.g. a
 * user-takeover request) defensively. It is pure so serialize/parse round-trips
 * are unit-tested; the actual schema VALIDATION lives in the protocol package
 * (ajv) and is wired by the control-plane — here we keep the field-level
 * construction correct and typed.
 *
 * No secret/token value is ever placed in a protocol payload: the noVNC token
 * travels only in the forwarded URL the bridge returns to the caller, never in
 * a broadcast event.
 */

import type {
  BrowserStarted,
  BrowserTwoFactorMethod,
  BrowserTwoFactorRequest,
  BrowserUserTakeoverChanged,
  BrowserUserTakeoverRequest,
  BrowserUserTakeoverState,
  UatExposurePolicy,
  UatRouteCreated,
  UatRouteExpired,
} from "@sentropic/remote-protocol";

/** `browser.started` payload — the headful browser came up over a transport. */
export function buildBrowserStarted(args: {
  browserId: string;
  metadata?: Record<string, unknown>;
}): BrowserStarted {
  return {
    browserId: args.browserId,
    // WP7 fork is noVNC headful — the transport is always "novnc" here.
    transport: "novnc",
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
}

/** `uat.route.created` payload — the forwardable noVNC route is open. */
export function buildUatRouteCreated(args: {
  routeId: string;
  url: string;
  port: number;
  expiresAt: string;
  exposurePolicy: UatExposurePolicy;
}): UatRouteCreated {
  return {
    routeId: args.routeId,
    url: args.url,
    port: args.port,
    expiresAt: args.expiresAt,
    exposurePolicy: args.exposurePolicy,
  };
}

/** `uat.route.expired` payload — the route is gone (TTL or explicit stop). */
export function buildUatRouteExpired(args: {
  routeId: string;
  expiredAt: string;
}): UatRouteExpired {
  return { routeId: args.routeId, expiredAt: args.expiredAt };
}

/** `browser.2fa.requested` payload — a 2FA challenge needs a human. */
export function buildTwoFactorRequest(args: {
  pageId: string;
  url: string;
  challengeId: string;
  method: BrowserTwoFactorMethod;
  requestedAt: string;
  expiresAt: string;
  context?: Record<string, unknown>;
}): BrowserTwoFactorRequest {
  return {
    pageId: args.pageId,
    url: args.url,
    challengeId: args.challengeId,
    method: args.method,
    requestedAt: args.requestedAt,
    expiresAt: args.expiresAt,
    ...(args.context ? { context: args.context } : {}),
  };
}

/** `browser.user-takeover.changed` payload — takeover state moved. */
export function buildUserTakeoverChanged(args: {
  pageId: string;
  state: BrowserUserTakeoverState;
  changedAt: string;
}): BrowserUserTakeoverChanged {
  return { pageId: args.pageId, state: args.state, changedAt: args.changedAt };
}

const TWO_FACTOR_METHODS: ReadonlyArray<BrowserTwoFactorMethod> = [
  "totp",
  "sms",
  "email",
  "webauthn",
  "unknown",
];

/** Narrow an arbitrary string to a known 2FA method, falling back to "unknown". */
export function coerceTwoFactorMethod(value: unknown): BrowserTwoFactorMethod {
  return typeof value === "string" &&
    (TWO_FACTOR_METHODS as ReadonlyArray<string>).includes(value)
    ? (value as BrowserTwoFactorMethod)
    : "unknown";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * Defensively parse an inbound `browser.user-takeover.requested` payload
 * (the user asking to drive the browser). Returns the typed request or a
 * parse error reason — never throws on malformed input.
 */
export function parseUserTakeoverRequest(
  raw: unknown,
):
  | { readonly ok: true; readonly value: BrowserUserTakeoverRequest }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "payload is not an object" };
  }
  if (!isNonEmptyString(raw.pageId)) {
    return { ok: false, reason: "missing/empty pageId" };
  }
  if (!isNonEmptyString(raw.reason)) {
    return { ok: false, reason: "missing/empty reason" };
  }
  if (!isNonEmptyString(raw.requestedAt)) {
    return { ok: false, reason: "missing/empty requestedAt" };
  }
  return {
    ok: true,
    value: {
      pageId: raw.pageId,
      reason: raw.reason,
      requestedAt: raw.requestedAt,
    },
  };
}
