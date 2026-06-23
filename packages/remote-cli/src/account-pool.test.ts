/**
 * Unit tests for account-pool.ts (WP16 Layer-C stub).
 *
 * All I/O is directed to a temp dir to avoid touching ~/.sentropic.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountsDescriptorPath,
  accountsTokensPath,
  appendSessionLogEntry,
  bindingsPath,
  clearBinding,
  clearExhaustion,
  enrollAccount,
  exportSessionLogToS3,
  isExhausted,
  listAccounts,
  listAccountsWithStatus,
  loadCandidates,
  lookupBinding,
  LLM_GATEWAY_URL,
  llmGatewayEnv,
  markExhausted,
  pruneExpiredQuota,
  QUOTA_WINDOW_5H_MS,
  QUOTA_WINDOW_WEEK_MS,
  quotaPath,
  removeAccount,
  selectAccount,
  selectAccountWithFallback,
  sessionLogPath,
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
  // Quota tracking (markExhausted / isExhausted / pruneExpiredQuota)
  // -------------------------------------------------------------------------

  it("quota: markExhausted persists record; isExhausted returns true within window", () => {
    enrollAccount({ provider: "claude-code", label: "a", accessToken: "tok", dir });
    const descs = listAccounts(dir);
    const id = descs[0]!.id;
    const rec = markExhausted(id, QUOTA_WINDOW_5H_MS, "429", dir);
    expect(rec.accountId).toBe(id);
    const now = Date.now();
    const quota: Record<string, typeof rec> = { [id]: rec };
    expect(isExhausted(id, quota, now)).toBe(true);
    // After the window, no longer exhausted
    expect(isExhausted(id, quota, now + QUOTA_WINDOW_5H_MS + 1)).toBe(false);
  });

  it("quota: clearExhaustion removes the record", () => {
    enrollAccount({ provider: "claude-code", label: "a", accessToken: "tok", dir });
    const id = listAccounts(dir)[0]!.id;
    markExhausted(id, QUOTA_WINDOW_5H_MS, undefined, dir);
    clearExhaustion(id, dir);
    const status = listAccountsWithStatus(dir);
    expect(status[0]!.exhausted).toBe(false);
  });

  it("quota: pruneExpiredQuota removes expired records and returns count", () => {
    enrollAccount({ provider: "claude-code", label: "a", accessToken: "tok", dir });
    const id = listAccounts(dir)[0]!.id;
    markExhausted(id, 1_000 /* 1s window */, undefined, dir);
    // Still in window
    expect(pruneExpiredQuota(Date.now(), dir)).toBe(0);
    // After window
    expect(pruneExpiredQuota(Date.now() + 2_000, dir)).toBe(1);
  });

  it("quotaPath: returns expected path inside dir", () => {
    expect(quotaPath(dir)).toContain("account-quota.json");
  });

  it("QUOTA_WINDOW constants: 5h and 7d in ms", () => {
    expect(QUOTA_WINDOW_5H_MS).toBe(5 * 60 * 60 * 1_000);
    expect(QUOTA_WINDOW_WEEK_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  // -------------------------------------------------------------------------
  // listAccountsWithStatus
  // -------------------------------------------------------------------------

  it("listAccountsWithStatus: shows exhausted=false when no quota record", () => {
    enrollAccount({ provider: "claude-code", label: "a", accessToken: "tok", dir });
    const list = listAccountsWithStatus(dir);
    expect(list[0]!.exhausted).toBe(false);
    expect(list[0]!.quotaResetsAt).toBeUndefined();
  });

  it("listAccountsWithStatus: shows exhausted=true + quotaResetsAt within window", () => {
    enrollAccount({ provider: "claude-code", label: "a", accessToken: "tok", dir });
    const id = listAccounts(dir)[0]!.id;
    markExhausted(id, QUOTA_WINDOW_5H_MS, undefined, dir);
    const list = listAccountsWithStatus(dir);
    expect(list[0]!.exhausted).toBe(true);
    expect(list[0]!.quotaResetsAt).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // selectAccountWithFallback
  // -------------------------------------------------------------------------

  it("selectAccountWithFallback: returns usable same-provider account", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    const result = selectAccountWithFallback("claude-code", undefined, dir);
    expect(result.candidate?.id).toBe("c1");
    expect("crossProvider" in result && result.crossProvider).toBe(false);
  });

  it("selectAccountWithFallback: skips exhausted account, picks next same-provider", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    enrollAccount({ provider: "claude-code", label: "c2", accessToken: "tok2", id: "c2", dir });
    markExhausted("c1", QUOTA_WINDOW_5H_MS, undefined, dir);
    const result = selectAccountWithFallback("claude-code", undefined, dir);
    expect(result.candidate?.id).toBe("c2");
    expect("crossProvider" in result && result.crossProvider).toBe(false);
  });

  it("selectAccountWithFallback: falls back to codex when all claude accounts exhausted", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    enrollAccount({ provider: "codex", label: "cod1", accessToken: "tok2", id: "cod1", dir });
    markExhausted("c1", QUOTA_WINDOW_5H_MS, undefined, dir);
    const result = selectAccountWithFallback("claude-code", undefined, dir);
    expect(result.candidate?.id).toBe("cod1");
    if ("crossProvider" in result && result.crossProvider) {
      expect(result.originalProvider).toBe("claude-code");
    } else {
      throw new Error("expected crossProvider=true");
    }
  });

  it("selectAccountWithFallback: returns allExhausted when all accounts exhausted", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    enrollAccount({ provider: "codex", label: "cod1", accessToken: "tok2", id: "cod1", dir });
    markExhausted("c1", QUOTA_WINDOW_5H_MS, undefined, dir);
    markExhausted("cod1", QUOTA_WINDOW_5H_MS, undefined, dir);
    const result = selectAccountWithFallback("claude-code", undefined, dir);
    expect(result.candidate).toBeUndefined();
    expect("allExhausted" in result && result.allExhausted).toBe(true);
  });

  it("selectAccountWithFallback: respects sticky binding when account is usable", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    enrollAccount({ provider: "claude-code", label: "c2", accessToken: "tok2", id: "c2", dir });
    stickyBind("ws-key", "c2", "claude-code", dir);
    const result = selectAccountWithFallback("claude-code", "ws-key", dir);
    expect(result.candidate?.id).toBe("c2");
  });

  it("selectAccountWithFallback: ignores sticky binding when bound account is exhausted", () => {
    enrollAccount({ provider: "claude-code", label: "c1", accessToken: "tok1", id: "c1", dir });
    enrollAccount({ provider: "claude-code", label: "c2", accessToken: "tok2", id: "c2", dir });
    stickyBind("ws-key", "c2", "claude-code", dir);
    markExhausted("c2", QUOTA_WINDOW_5H_MS, undefined, dir);
    const result = selectAccountWithFallback("claude-code", "ws-key", dir);
    // Should fall through to c1 (round-robin skipping exhausted c2)
    expect(result.candidate?.id).toBe("c1");
  });

  // -------------------------------------------------------------------------
  // configDir on AccountDescriptor (multi-account claude)
  // -------------------------------------------------------------------------

  it("enroll: persists configDir in descriptor for claude-code accounts", () => {
    const result = enrollAccount({
      provider: "claude-code",
      label: "Work",
      accessToken: "sk-ant-work",
      id: "claude-work",
      configDir: "/home/user/.claude-work",
      dir,
    });
    expect(result.ok).toBe(true);
    const descs = listAccounts(dir);
    expect(descs[0]!.configDir).toBe("/home/user/.claude-work");
  });

  it("enroll: no configDir when not provided", () => {
    enrollAccount({ provider: "claude-code", label: "Main", accessToken: "tok", id: "main", dir });
    const descs = listAccounts(dir);
    expect(descs[0]!.configDir).toBeUndefined();
  });

  it("loadCandidates: carries configDir through to candidates", () => {
    enrollAccount({
      provider: "claude-code",
      label: "Work",
      accessToken: "tok-work",
      id: "work",
      configDir: "/home/user/.claude-work",
      dir,
    });
    const candidates = loadCandidates("claude-code", dir);
    expect(candidates[0]!.configDir).toBe("/home/user/.claude-work");
  });

  // -------------------------------------------------------------------------
  // Session log (appendSessionLogEntry)
  // -------------------------------------------------------------------------

  it("appendSessionLogEntry: writes a JSONL line to session-log.jsonl", () => {
    appendSessionLogEntry({
      jobId: "test-job-1",
      preferredProvider: "claude-code",
      selectedProvider: "claude-code",
      accountId: "claude-a",
      accountLabel: "Main",
      crossProvider: false,
    }, dir);
    const log = readFileSync(sessionLogPath(dir), "utf8");
    const entry = JSON.parse(log.trim());
    expect(entry.jobId).toBe("test-job-1");
    expect(entry.crossProvider).toBe(false);
    expect(entry.at).toBeTruthy();
  });

  it("appendSessionLogEntry: multiple calls append multiple lines", () => {
    appendSessionLogEntry({ jobId: "j1", preferredProvider: "claude-code", selectedProvider: "claude-code", accountId: "a", accountLabel: "A", crossProvider: false }, dir);
    appendSessionLogEntry({ jobId: "j2", preferredProvider: "claude-code", selectedProvider: "codex", accountId: "b", accountLabel: "B", crossProvider: true }, dir);
    const lines = readFileSync(sessionLogPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).jobId).toBe("j1");
    expect(JSON.parse(lines[1]!).crossProvider).toBe(true);
  });

  it("appendSessionLogEntry: kind=exhaust + signature persisted", () => {
    appendSessionLogEntry({
      kind: "exhaust",
      jobId: "j-exhaust",
      preferredProvider: "claude-code",
      selectedProvider: "claude-code",
      accountId: "a",
      accountLabel: "Work",
      crossProvider: false,
      signature: "claude:rate-limited",
    }, dir);
    const entry = JSON.parse(readFileSync(sessionLogPath(dir), "utf8").trim());
    expect(entry.kind).toBe("exhaust");
    expect(entry.signature).toBe("claude:rate-limited");
  });

  it("appendSessionLogEntry: kind absent means launch (back-compat)", () => {
    appendSessionLogEntry({ jobId: "j-compat", preferredProvider: "claude-code", selectedProvider: "claude-code", accountId: "a", accountLabel: "Work", crossProvider: false }, dir);
    const entry = JSON.parse(readFileSync(sessionLogPath(dir), "utf8").trim());
    expect(entry.kind).toBeUndefined();
  });

  it("sessionLogPath: returns path inside dir", () => {
    expect(sessionLogPath(dir)).toContain("session-log.jsonl");
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

  // -------------------------------------------------------------------------
  // exportSessionLogToS3
  // -------------------------------------------------------------------------

  it("exportSessionLogToS3: rejects invalid S3 URI", async () => {
    await expect(exportSessionLogToS3("not-an-s3-uri", dir)).rejects.toThrow("Invalid S3 URI");
  });

  it("exportSessionLogToS3: rejects missing log file", async () => {
    await expect(exportSessionLogToS3("s3://bucket/key.jsonl", dir)).rejects.toThrow("Session log not found");
  });

  it("exportSessionLogToS3: calls S3Client.send with PutObjectCommand", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    vi.doMock("@aws-sdk/client-s3", () => ({
      S3Client: class { send = sendMock; },
      PutObjectCommand: class { constructor(public params: unknown) {} },
    }));
    writeFileSync(sessionLogPath(dir), '{"at":"2026-01-01","jobId":"j1"}\n');
    await exportSessionLogToS3("s3://my-bucket/logs/session-log.jsonl", dir);
    expect(sendMock).toHaveBeenCalledOnce();
    const cmd = sendMock.mock.calls[0]![0] as { params: { Bucket: string; Key: string } };
    expect(cmd.params.Bucket).toBe("my-bucket");
    expect(cmd.params.Key).toBe("logs/session-log.jsonl");
    vi.doUnmock("@aws-sdk/client-s3");
  });
});
