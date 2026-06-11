import { describe, expect, it } from "vitest";

import {
  buildBrowserStarted,
  buildTwoFactorRequest,
  buildUatRouteCreated,
  buildUatRouteExpired,
  buildUserTakeoverChanged,
  coerceTwoFactorMethod,
  parseUserTakeoverRequest,
} from "./protocol.js";

describe("browser.* / uat.* payload builders", () => {
  it("browser.started uses the novnc transport (WP7 fork)", () => {
    const p = buildBrowserStarted({ browserId: "br-1" });
    expect(p.transport).toBe("novnc");
    expect(p.browserId).toBe("br-1");
    expect(p.metadata).toBeUndefined();
  });

  it("browser.started carries metadata when provided", () => {
    const p = buildBrowserStarted({
      browserId: "br-1",
      metadata: { interactive: true },
    });
    expect(p.metadata).toEqual({ interactive: true });
  });

  it("uat.route.created carries the forwardable URL + policy", () => {
    const p = buildUatRouteCreated({
      routeId: "uat-1",
      url: "http://localhost:6080/vnc.html?path=websockify%3Ftoken%3Dx",
      port: 6080,
      expiresAt: "2026-06-10T10:00:00.000Z",
      exposurePolicy: "session-private",
    });
    expect(p.port).toBe(6080);
    expect(p.exposurePolicy).toBe("session-private");
    expect(p.url).toContain("vnc.html");
  });

  it("uat.route.expired round-trips", () => {
    const p = buildUatRouteExpired({
      routeId: "uat-1",
      expiredAt: "2026-06-10T11:00:00.000Z",
    });
    expect(p).toEqual({
      routeId: "uat-1",
      expiredAt: "2026-06-10T11:00:00.000Z",
    });
  });

  it("browser.2fa.requested includes the challenge fields", () => {
    const p = buildTwoFactorRequest({
      pageId: "pg-1",
      url: "https://example.test/2fa",
      challengeId: "ch-1",
      method: "totp",
      requestedAt: "2026-06-10T10:00:00.000Z",
      expiresAt: "2026-06-10T10:05:00.000Z",
      context: { provider: "okta" },
    });
    expect(p.method).toBe("totp");
    expect(p.context).toEqual({ provider: "okta" });
  });

  it("browser.user-takeover.changed reflects the state", () => {
    const p = buildUserTakeoverChanged({
      pageId: "pg-1",
      state: "active",
      changedAt: "2026-06-10T10:00:00.000Z",
    });
    expect(p.state).toBe("active");
  });
});

describe("coerceTwoFactorMethod", () => {
  it("keeps known methods", () => {
    for (const m of ["totp", "sms", "email", "webauthn", "unknown"]) {
      expect(coerceTwoFactorMethod(m)).toBe(m);
    }
  });
  it("falls back to unknown for anything else", () => {
    expect(coerceTwoFactorMethod("push")).toBe("unknown");
    expect(coerceTwoFactorMethod(42)).toBe("unknown");
    expect(coerceTwoFactorMethod(null)).toBe("unknown");
  });
});

describe("parseUserTakeoverRequest", () => {
  it("accepts a well-formed request", () => {
    const r = parseUserTakeoverRequest({
      pageId: "pg-1",
      reason: "needs 2fa",
      requestedAt: "2026-06-10T10:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pageId).toBe("pg-1");
  });

  it("rejects non-objects", () => {
    const r = parseUserTakeoverRequest("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("object");
  });

  it("rejects missing fields", () => {
    for (const bad of [
      { reason: "x", requestedAt: "t" },
      { pageId: "p", requestedAt: "t" },
      { pageId: "p", reason: "x" },
      { pageId: "", reason: "x", requestedAt: "t" },
    ]) {
      expect(parseUserTakeoverRequest(bad).ok).toBe(false);
    }
  });
});
