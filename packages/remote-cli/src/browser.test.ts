import { describe, expect, it } from "vitest";

import { buildBrowserOpenPlan } from "./browser.js";

const fixedRng = (n: number) => new Uint8Array(n).fill(0xab);
const TOKEN = "ab".repeat(16);

describe("buildBrowserOpenPlan", () => {
  it("defaults to session-private + interactive and prints forward + URL", () => {
    const plan = buildBrowserOpenPlan({ sessionId: "sess-1", rng: fixedRng });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.podPort).toBe(6080);
    expect(plan.forwardCommand).toBe("remote forward sess-1 6080");
    expect(new URL(plan.url).searchParams.get("path")).toBe(
      `websockify?token=${TOKEN}`,
    );
    // interactive default → no view_only.
    expect(new URL(plan.url).searchParams.get("view_only")).toBeNull();
    expect(plan.instructions).toContain("remote forward sess-1 6080");
    expect(plan.instructions).toContain(plan.url);
  });

  it("threads a local port into BOTH the forward command and the URL", () => {
    const plan = buildBrowserOpenPlan({
      sessionId: "sess-1",
      localPort: 7090,
      rng: fixedRng,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.forwardCommand).toBe("remote forward sess-1 6080 7090");
    expect(Number(new URL(plan.url).port)).toBe(7090);
  });

  it("emits view_only when interactive=false", () => {
    const plan = buildBrowserOpenPlan({
      sessionId: "sess-1",
      interactive: false,
      rng: fixedRng,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok)
      expect(new URL(plan.url).searchParams.get("view_only")).toBe("true");
  });

  it("DENIES an anonymous requester on the session-private default", () => {
    const plan = buildBrowserOpenPlan({
      sessionId: "sess-1",
      requester: "anonymous",
      rng: fixedRng,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("anonymous");
  });

  it("DENIES public-expiring without a TTL", () => {
    const plan = buildBrowserOpenPlan({
      sessionId: "sess-1",
      exposurePolicy: "public-expiring",
      rng: fixedRng,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("expiry");
  });

  it("ALLOWS public-expiring with a positive TTL", () => {
    const plan = buildBrowserOpenPlan({
      sessionId: "sess-1",
      exposurePolicy: "public-expiring",
      ttlMs: 60_000,
      rng: fixedRng,
    });
    expect(plan.ok).toBe(true);
  });
});
