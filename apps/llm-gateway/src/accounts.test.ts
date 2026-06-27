import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAccounts", () => {
  it("throws when GATEWAY_ACCOUNTS is absent", async () => {
    vi.stubEnv("GATEWAY_ACCOUNTS", "");
    const { getAccounts, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    expect(() => getAccounts()).toThrow("GATEWAY_ACCOUNTS");
  });

  it("parses a valid account list", async () => {
    const accounts = [
      { id: "c1", provider: "claude-code", label: "Claude A", token: "sk-ant-1" },
    ];
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const { getAccounts, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    expect(getAccounts()).toHaveLength(1);
    expect(getAccounts()[0]!.id).toBe("c1");
  });

  it("throws on empty array", async () => {
    vi.stubEnv("GATEWAY_ACCOUNTS", "[]");
    const { getAccounts, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    expect(() => getAccounts()).toThrow("non-empty");
  });

  it("filters Claude Code OAuth accounts because they are not API upstream credentials", async () => {
    const accounts = [
      {
        id: "claude-oauth",
        provider: "anthropic",
        label: "Claude OAuth",
        token: "sk-ant-oat01-local",
        authType: "bearer",
      },
      { id: "codex-oauth", provider: "openai", label: "Codex", token: "jwt.token.value" },
    ];
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const { getAccounts, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    expect(getAccounts().map((a) => a.id)).toEqual(["codex-oauth"]);
  });

  it("throws when only unsupported Claude Code OAuth accounts are configured", async () => {
    const accounts = [
      {
        id: "claude-oauth",
        provider: "anthropic",
        label: "Claude OAuth",
        token: "sk-ant-oat01-local",
      },
    ];
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const { getAccounts, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    expect(() => getAccounts()).toThrow("Claude Code OAuth is not a supported upstream transport");
  });
});

describe("selectAccount", () => {
  it("round-robins across accounts", async () => {
    const accounts = [
      { id: "c1", provider: "claude-code", label: "A", token: "t1" },
      { id: "c2", provider: "claude-code", label: "B", token: "t2" },
    ];
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const { selectAccount, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();
    const first = selectAccount();
    const second = selectAccount();
    const third = selectAccount();
    expect(first.id).toBe("c1");
    expect(second.id).toBe("c2");
    expect(third.id).toBe("c1");
  });
});

describe("account descriptors and route selection", () => {
  it("exposes descriptor-only account views without raw tokens", async () => {
    const accounts = [
      {
        id: "codex-a",
        provider: "openai",
        label: "Codex A",
        token: "secret-token",
        refreshToken: "secret-refresh",
        modelIds: ["gpt-5.5"],
      },
    ];
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const { listAccountDescriptors, resetAccountsCache } = await import("./accounts.js");
    resetAccountsCache();

    const descriptors = listAccountDescriptors();
    expect(descriptors).toEqual([
      {
        id: "codex-a",
        provider: "openai",
        label: "Codex A",
        modelIds: ["gpt-5.5"],
        status: "active",
      },
    ]);
    expect(JSON.stringify(descriptors)).not.toContain("secret");
  });

  it("selectAccountForRoute only chooses accounts that can serve the route", async () => {
    vi.stubEnv(
      "GATEWAY_ACCOUNTS",
      JSON.stringify([
        { id: "claude-a", provider: "anthropic", label: "Claude A", token: "sk-ant-a" },
        { id: "codex-a", provider: "openai", label: "Codex A", token: "sk-openai-a" },
        { id: "codex-b", provider: "codex", label: "Codex B", token: "jwt.token.value" },
      ]),
    );
    const { selectAccountForRoute, resetAccountsCache } = await import("./accounts.js");
    const { resolveModelRoute } = await import("./model-catalog.js");
    resetAccountsCache();

    const route = resolveModelRoute("gpt-5.5");
    expect(route).toBeDefined();
    expect(selectAccountForRoute(route!).id).toBe("codex-a");
    expect(selectAccountForRoute(route!).id).toBe("codex-b");
  });

  it("selectAccountForRoute rejects when no account can serve the requested pool", async () => {
    vi.stubEnv(
      "GATEWAY_ACCOUNTS",
      JSON.stringify([
        { id: "claude-a", provider: "anthropic", label: "Claude A", token: "sk-ant-a" },
      ]),
    );
    const { selectAccountForRoute, resetAccountsCache } = await import("./accounts.js");
    const { resolveModelRoute } = await import("./model-catalog.js");
    resetAccountsCache();

    const route = resolveModelRoute("gpt-5.5");
    expect(() => selectAccountForRoute(route!)).toThrow("no eligible codex account");
  });
});
