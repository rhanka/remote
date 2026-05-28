import { describe, expect, it } from "vitest";
import { tenantNamespace } from "./namespace.js";

describe("tenantNamespace", () => {
  it("maps the default user to the shared namespace", () => {
    expect(tenantNamespace("default")).toBe("sentropic-remote");
  });
  it("is deterministic and DNS-safe for arbitrary ids", () => {
    const ns = tenantNamespace("alice@example.com");
    expect(ns).toBe(tenantNamespace("alice@example.com"));
    expect(ns).toMatch(/^user-[a-f0-9]{8}$/);
  });
});
