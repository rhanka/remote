import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QUOTA_EXHAUSTION_MS,
  isAccountExhausted,
  markAccountExhausted,
  providerFamily,
  resetAccountsCache,
  selectAccount,
  selectFallbackAccount,
} from "./accounts.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetAccountsCache();
});

describe("llm-gateway account quota fallback", () => {
  it("classifies gateway provider families", () => {
    expect(providerFamily("anthropic")).toBe("anthropic");
    expect(providerFamily("claude-code")).toBe("anthropic");
    expect(providerFamily("openai")).toBe("openai");
    expect(providerFamily("codex")).toBe("openai");
    expect(providerFamily("other")).toBe("other");
  });

  it("selectAccount skips an exhausted account while the quota window is active", () => {
    vi.stubEnv(
      "GATEWAY_ACCOUNTS",
      JSON.stringify([
        {
          id: "claude-a",
          provider: "anthropic",
          label: "Claude A",
          token: "sk-ant-a",
        },
        {
          id: "codex-a",
          provider: "openai",
          label: "Codex A",
          token: "sk-openai-a",
        },
      ]),
    );
    resetAccountsCache();

    markAccountExhausted("claude-a", "upstream 429");

    expect(selectAccount().id).toBe("codex-a");
    expect(isAccountExhausted("claude-a")).toBe(true);
  });

  it("selectFallbackAccount prefers same-provider accounts, then cross-provider accounts", () => {
    vi.stubEnv(
      "GATEWAY_ACCOUNTS",
      JSON.stringify([
        {
          id: "claude-a",
          provider: "anthropic",
          label: "Claude A",
          token: "sk-ant-a",
        },
        {
          id: "claude-b",
          provider: "anthropic",
          label: "Claude B",
          token: "sk-ant-b",
        },
        {
          id: "codex-a",
          provider: "openai",
          label: "Codex A",
          token: "sk-openai-a",
        },
      ]),
    );
    resetAccountsCache();

    expect(selectFallbackAccount("claude-a")?.id).toBe("claude-b");
    markAccountExhausted("claude-b", "upstream 429");
    expect(selectFallbackAccount("claude-a")?.id).toBe("codex-a");
  });

  it("expired exhaustion windows are pruned on read", () => {
    vi.stubEnv(
      "GATEWAY_ACCOUNTS",
      JSON.stringify([
        {
          id: "claude-a",
          provider: "anthropic",
          label: "Claude A",
          token: "sk-ant-a",
        },
        {
          id: "codex-a",
          provider: "openai",
          label: "Codex A",
          token: "sk-openai-a",
        },
      ]),
    );
    resetAccountsCache();

    const now = Date.parse("2026-06-27T12:00:00.000Z");
    markAccountExhausted("claude-a", "upstream 429", 1_000, now);

    expect(isAccountExhausted("claude-a", now + 999)).toBe(true);
    expect(isAccountExhausted("claude-a", now + 1_000)).toBe(false);
    expect(selectFallbackAccount("codex-a", now + 1_000)?.id).toBe("claude-a");
  });

  it("uses a five-hour default quota exhaustion window", () => {
    expect(DEFAULT_QUOTA_EXHAUSTION_MS).toBe(5 * 60 * 60 * 1000);
  });
});
