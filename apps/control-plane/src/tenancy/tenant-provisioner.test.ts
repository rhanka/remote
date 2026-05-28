import { describe, expect, it, vi } from "vitest";
import { StubTenantProvisioner, PocK8sTenantProvisioner } from "./tenant-provisioner.js";

describe("StubTenantProvisioner", () => {
  it("returns the shared namespace for any user", async () => {
    const t = new StubTenantProvisioner();
    expect((await t.ensureTenant("alice")).namespace).toBe(
      "user-" +
        (await import("node:crypto"))
          .createHash("sha256")
          .update("alice")
          .digest("hex")
          .slice(0, 8),
    );
  });
  it("maps default to the shared namespace", async () => {
    const t = new StubTenantProvisioner();
    expect((await t.ensureTenant("default")).namespace).toBe("sentropic-remote");
  });
});

describe("PocK8sTenantProvisioner", () => {
  it("POSTs the userId and returns the namespace", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ namespace: "user-abc12345", status: "ready" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const t = new PocK8sTenantProvisioner("http://poc:9000", fetchImpl);
    const out = await t.ensureTenant("alice");
    expect(out.namespace).toBe("user-abc12345");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://poc:9000/tenants",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("caches per user (second call does not re-POST)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ namespace: "user-abc12345" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const t = new PocK8sTenantProvisioner("http://poc:9000", fetchImpl);
    await t.ensureTenant("alice");
    await t.ensureTenant("alice");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
