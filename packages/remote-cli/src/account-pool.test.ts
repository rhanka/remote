/**
 * Unit tests for account-pool.ts (WP16 Layer-C stub).
 *
 * All I/O is directed to a temp dir to avoid touching ~/.sentropic.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  accountsDescriptorPath,
  accountsTokensPath,
  bindingsPath,
  clearBinding,
  enrollAccount,
  listAccounts,
  loadCandidates,
  lookupBinding,
  LLM_GATEWAY_URL,
  llmGatewayEnv,
  removeAccount,
  selectAccount,
  stickyBind,
} from "./account-pool.js";

const SCRATCH = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "account-pool",
);
mkdirSync(SCRATCH, { recursive: true });

describe("account-pool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(SCRATCH, "pool-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // enrollAccount
  // -------------------------------------------------------------------------

  it("enroll: writes descriptor and token to separate 0600 files", () => {
    const result = enrollAccount({
      provider: "claude-code",
      label: "Claude A",
      accessToken: "sk-ant-test-abc123",
      id: "claude-a",
      dir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.id).toBe("claude-a");
    expect(result.descriptor.provider).toBe("claude-code");
    expect(result.descriptor.label).toBe("Claude A");
    expect(result.descriptor.enrolledAt).toBeTruthy();

    // Descriptor file exists and is 0600
    const descPath = accountsDescriptorPath(dir);
    expect(existsSync(descPath)).toBe(true);
    expect(statSync(descPath).mode & 0o777).toBe(0o600);

    // Token file exists and is 0600
    const tokPath = accountsTokensPath(dir);
    expect(existsSync(tokPath)).toBe(true);
    expect(statSync(tokPath).mode & 0o777).toBe(0o600);
  });

  it("enroll: rejects empty access token", () => {
    const result = enrollAccount({
      provider: "claude-code",
      label: "Bad",
      accessToken: "  ",
      dir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/empty/);
  });

  it("enroll: rejects duplicate id", () => {
    enrollAccount({
      provider: "claude-code",
      label: "A",
      accessToken: "tok1",
      id: "dup",
      dir,
    });
    const second = enrollAccount({
      provider: "codex",
      label: "B",
      accessToken: "tok2",
      id: "dup",
      dir,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already enrolled/);
  });

  it("enroll: multiple accounts accumulate in descriptor list", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "t1", id: "a", dir });
    enrollAccount({ provider: "codex", label: "B", accessToken: "t2", id: "b", dir });
    const descs = listAccounts(dir);
    expect(descs).toHaveLength(2);
    expect(descs.map((d) => d.id)).toEqual(["a", "b"]);
  });

  // -------------------------------------------------------------------------
  // listAccounts / loadCandidates
  // -------------------------------------------------------------------------

  it("listAccounts: returns empty array when no accounts enrolled", () => {
    expect(listAccounts(dir)).toEqual([]);
  });

  it("loadCandidates: returns descriptor + token pairs (tokens not in descriptor file)", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "tok-a", id: "ca", dir });
    const candidates = loadCandidates(undefined, dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.accessToken).toBe("tok-a");
    // token must NOT appear in the descriptor file
    const descs = listAccounts(dir);
    expect(JSON.stringify(descs)).not.toContain("tok-a");
  });

  it("loadCandidates: filters by provider", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "ta", id: "ca", dir });
    enrollAccount({ provider: "codex", label: "B", accessToken: "tb", id: "cb", dir });
    const claudeOnly = loadCandidates("claude-code", dir);
    expect(claudeOnly).toHaveLength(1);
    expect(claudeOnly[0]!.provider).toBe("claude-code");
  });

  // -------------------------------------------------------------------------
  // removeAccount
  // -------------------------------------------------------------------------

  it("remove: removes descriptor and token, returns ok", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "tok", id: "a", dir });
    const result = removeAccount("a", dir);
    expect(result.ok).toBe(true);
    expect(listAccounts(dir)).toHaveLength(0);
    expect(loadCandidates(undefined, dir)).toHaveLength(0);
  });

  it("remove: returns error for unknown id", () => {
    const result = removeAccount("nonexistent", dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/);
  });

  // -------------------------------------------------------------------------
  // selectAccount — pure planner
  // -------------------------------------------------------------------------

  it("selectAccount: returns undefined when no candidates", () => {
    expect(selectAccount([])).toBeUndefined();
  });

  it("selectAccount: returns first when no lastUsedId", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "ta", id: "a", dir });
    enrollAccount({ provider: "claude-code", label: "B", accessToken: "tb", id: "b", dir });
    const descs = listAccounts(dir);
    const pick = selectAccount(descs);
    expect(pick?.id).toBe("a");
  });

  it("selectAccount: round-robin advances past lastUsedId", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "ta", id: "a", dir });
    enrollAccount({ provider: "claude-code", label: "B", accessToken: "tb", id: "b", dir });
    enrollAccount({ provider: "claude-code", label: "C", accessToken: "tc", id: "c", dir });
    const descs = listAccounts(dir);
    expect(selectAccount(descs, "a")?.id).toBe("b");
    expect(selectAccount(descs, "b")?.id).toBe("c");
    expect(selectAccount(descs, "c")?.id).toBe("a"); // wraps
  });

  it("selectAccount: falls back to first when lastUsedId not found", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "ta", id: "a", dir });
    enrollAccount({ provider: "claude-code", label: "B", accessToken: "tb", id: "b", dir });
    const descs = listAccounts(dir);
    expect(selectAccount(descs, "unknown")?.id).toBe("a");
  });

  it("selectAccount: single-account pool always returns the one account (sticky)", () => {
    enrollAccount({ provider: "claude-code", label: "A", accessToken: "ta", id: "a", dir });
    const descs = listAccounts(dir);
    expect(selectAccount(descs, "a")?.id).toBe("a"); // wraps to itself
  });

  // -------------------------------------------------------------------------
  // Sticky binding
  // -------------------------------------------------------------------------

  it("stickyBind / lookupBinding: persist and retrieve a binding", () => {
    const binding = stickyBind("key-sess-1", "claude-a", "claude-code", dir);
    expect(binding.affinityKey).toBe("key-sess-1");
    expect(binding.accountId).toBe("claude-a");

    const found = lookupBinding("key-sess-1", dir);
    expect(found).toBeDefined();
    expect(found?.accountId).toBe("claude-a");

    // Binding file is 0600
    expect(statSync(bindingsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("lookupBinding: returns undefined for unknown key", () => {
    expect(lookupBinding("no-such-key", dir)).toBeUndefined();
  });

  it("clearBinding: removes the binding (explicit rebind path)", () => {
    stickyBind("key-sess-2", "claude-a", "claude-code", dir);
    clearBinding("key-sess-2", dir);
    expect(lookupBinding("key-sess-2", dir)).toBeUndefined();
  });

  it("stickyBind: overwrite existing binding (explicit rebind — not silent)", () => {
    stickyBind("key-sess-3", "claude-a", "claude-code", dir);
    stickyBind("key-sess-3", "claude-b", "claude-code", dir);
    expect(lookupBinding("key-sess-3", dir)?.accountId).toBe("claude-b");
  });

  it("stickyBind: independent keys do not interfere", () => {
    stickyBind("key-A", "acc-1", "claude-code", dir);
    stickyBind("key-B", "acc-2", "codex", dir);
    expect(lookupBinding("key-A", dir)?.accountId).toBe("acc-1");
    expect(lookupBinding("key-B", dir)?.accountId).toBe("acc-2");
  });

  // -------------------------------------------------------------------------
  // Gateway constants
  // -------------------------------------------------------------------------

  it("LLM_GATEWAY_URL is the stable Layer-B ingress", () => {
    expect(LLM_GATEWAY_URL).toBe("https://llm.sent-tech.ca");
  });

  it("llmGatewayEnv returns ANTHROPIC_BASE_URL pointing to gateway", () => {
    const env = llmGatewayEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.sent-tech.ca");
  });
});
