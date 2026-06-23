import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the accounts module to avoid GATEWAY_ACCOUNTS requirement
vi.mock("./accounts.js", () => ({
  selectAccount: vi.fn(() => ({ id: "c1", provider: "claude-code", label: "A", token: "sk-ant-1" })),
  findAccount: vi.fn((id: string) =>
    id === "c1"
      ? { id: "c1", provider: "claude-code", label: "A", token: "sk-ant-1" }
      : undefined,
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acquireSession", () => {
  it("assigns a new account via round-robin on first call", async () => {
    // Mock readSticky to return empty (no existing binding)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));

    const { acquireSession } = await import("./sticky.js");
    const result = await acquireSession("sess-001");
    expect(result.accountId).toBe("c1");
    expect(result.gatewayToken).toMatch(/^gw-[0-9a-f]{32}$/);
  });

  it("returns same accountId for same sessionId (idempotent)", async () => {
    // First call: 404 → assigns c1, writes to ConfigMap
    // Second call: ConfigMap returns c1
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, ok: false }) // readSticky 1st call
      .mockResolvedValueOnce({ ok: true }) // writeSticky
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { "sess-002": "c1" } }),
      }); // readSticky 2nd call

    vi.stubGlobal("fetch", fetchMock);

    const { acquireSession } = await import("./sticky.js");
    const r1 = await acquireSession("sess-002");
    const r2 = await acquireSession("sess-002");

    expect(r1.accountId).toBe("c1");
    expect(r2.accountId).toBe("c1");
    // Different gatewayTokens (new token each call, but same account)
    expect(r1.gatewayToken).not.toBe(r2.gatewayToken);
  });

  it("returns a gateway token that lookupToken can find", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));

    const { acquireSession, lookupToken } = await import("./sticky.js");
    const { gatewayToken } = await acquireSession("sess-003");
    const entry = lookupToken(gatewayToken);
    expect(entry).toBeDefined();
    expect(entry!.accountId).toBe("c1");
    // Token must never leak into the entry's visible surface without being the actual secret
    // (token is needed for forwarding but should never be logged)
    expect(entry!.token).toBe("sk-ant-1");
  });
});
