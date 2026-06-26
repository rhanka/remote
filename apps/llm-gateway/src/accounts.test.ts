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
