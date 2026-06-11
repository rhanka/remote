import { describe, expect, it } from "vitest";

import { evaluateExposure, type ExposureRequester } from "./policy.js";

const requesters: ReadonlyArray<ExposureRequester> = [
  "operator",
  "session-owner",
  "anonymous",
];

describe("uat-exposure-policy enforcement", () => {
  describe("operator-only", () => {
    it("allows only the operator", () => {
      for (const r of requesters) {
        const d = evaluateExposure({
          policy: "operator-only",
          requester: r,
          hasToken: true,
        });
        if (r === "operator") expect(d.allowed).toBe(true);
        else {
          expect(d.allowed).toBe(false);
          if (!d.allowed) expect(d.reason).toContain("operator-only");
        }
      }
    });

    it("allows the operator even without a token", () => {
      const d = evaluateExposure({
        policy: "operator-only",
        requester: "operator",
        hasToken: false,
      });
      expect(d.allowed).toBe(true);
    });
  });

  describe("session-private", () => {
    it("allows operator and session-owner WITH a token", () => {
      for (const r of ["operator", "session-owner"] as const) {
        expect(
          evaluateExposure({
            policy: "session-private",
            requester: r,
            hasToken: true,
          }).allowed,
        ).toBe(true);
      }
    });

    it("denies a token-less route", () => {
      const d = evaluateExposure({
        policy: "session-private",
        requester: "session-owner",
        hasToken: false,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain("token");
    });

    it("denies an anonymous requester even with a token", () => {
      const d = evaluateExposure({
        policy: "session-private",
        requester: "anonymous",
        hasToken: true,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain("anonymous");
    });
  });

  describe("public-expiring", () => {
    it("allows any requester WITH a token AND a positive expiry", () => {
      for (const r of requesters) {
        expect(
          evaluateExposure({
            policy: "public-expiring",
            requester: r,
            hasToken: true,
            expiresInMs: 60_000,
          }).allowed,
        ).toBe(true);
      }
    });

    it("denies without a token", () => {
      const d = evaluateExposure({
        policy: "public-expiring",
        requester: "anonymous",
        hasToken: false,
        expiresInMs: 60_000,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toContain("token");
    });

    it("denies an open-ended (no/zero/negative) expiry", () => {
      for (const expiresInMs of [undefined, 0, -1]) {
        const d = evaluateExposure({
          policy: "public-expiring",
          requester: "operator",
          hasToken: true,
          ...(expiresInMs !== undefined ? { expiresInMs } : {}),
        });
        expect(d.allowed).toBe(false);
        if (!d.allowed) expect(d.reason).toContain("expiry");
      }
    });
  });
});
