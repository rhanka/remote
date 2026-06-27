import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock the accounts module to avoid GATEWAY_ACCOUNTS requirement
vi.mock("./accounts.js", () => ({
  selectAccount: vi.fn(() => ({
    id: "c1",
    provider: "claude-code",
    label: "A",
    token: "sk-ant-1",
  })),
  selectAccountForRoute: vi.fn(() => ({
    id: "c1",
    provider: "claude-code",
    label: "A",
    token: "sk-ant-1",
  })),
  accountSupportsRoute: vi.fn(() => true),
  publicAccountDescriptor: vi.fn((account) => ({
    id: account.id,
    provider: account.provider,
    label: account.label,
    modelIds: [],
    status: "active",
  })),
  findAccount: vi.fn((id: string) =>
    id === "c1"
      ? { id: "c1", provider: "claude-code", label: "A", token: "sk-ant-1" }
      : undefined,
  ),
}));

beforeEach(() => {
  process.env.LLM_GATEWAY_TOKEN_SEED = "test-seed";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.LLM_GATEWAY_TOKEN_SEED;
});

describe("acquireSession", () => {
  it("assigns a new account via round-robin on first call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false }),
    );

    const { acquireSession } = await import("./sticky.js");
    const result = await acquireSession("sess-001");
    expect(result.accountId).toBe("c1");
    expect(result.gatewayToken).toMatch(/^gw-v1-[^.]+\.[A-Za-z0-9_-]+$/);
  });

  it("returns same accountId and token for same sessionId (idempotent)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { "sess-002": "c1" } }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const { acquireSession } = await import("./sticky.js");
    const r1 = await acquireSession("sess-002");
    const r2 = await acquireSession("sess-002");

    expect(r1.accountId).toBe("c1");
    expect(r2.accountId).toBe("c1");
    expect(r1.gatewayToken).toBe(r2.gatewayToken);
  });

  it("returns a gateway token that lookupToken can find", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false }),
    );

    const { acquireSession, lookupToken } = await import("./sticky.js");
    const { gatewayToken } = await acquireSession("sess-003");
    const entry = await lookupToken(gatewayToken);
    expect(entry).toBeDefined();
    expect(entry!.accountId).toBe("c1");
    expect(entry!.token).toBe("sk-ant-1");
  });

  it("derives different stable tokens for different sessionIds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false }),
    );

    const { acquireSession } = await import("./sticky.js");
    const r1 = await acquireSession("sess-a");
    const r2 = await acquireSession("sess-b");

    expect(r1.gatewayToken).not.toBe(r2.gatewayToken);
  });

  it("rejects valid-looking tokens if the seed changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false }),
    );

    const { acquireSession } = await import("./sticky.js");
    const { gatewayToken } = await acquireSession("sess-seed");

    vi.resetModules();
    process.env.LLM_GATEWAY_TOKEN_SEED = "other-seed";
    const fresh = await import("./sticky.js");
    expect(await fresh.lookupToken(gatewayToken)).toBeUndefined();
  });
});
