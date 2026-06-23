/**
 * WP16 Layer-C — local LLM account pool.
 *
 * Descriptor store: ~/.sentropic/accounts.json (0600) — id, provider, label, enrolledAt.
 * Token store:      ~/.sentropic/accounts-tokens.json (0600) — secrets only, separate file.
 *
 * Invariants:
 *  - No tokens ever appear in descriptors, stdout, logs, or track.
 *  - Both files are 0600 (owner-only). mkdirSync enforces ~/.sentropic/ exists.
 *  - selectAccount() is pure: no I/O, just candidates + policy → one descriptor.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AccountProvider = "claude-code" | "codex";

export type AccountDescriptor = {
  readonly id: string;
  readonly provider: AccountProvider;
  readonly label: string;
  readonly enrolledAt: string;
  /** For claude-code accounts: the config dir holding credentials (maps to CLAUDE_CONFIG_DIR). Absent = default ~/.claude. */
  readonly configDir?: string;
};

export type AccountCandidate = AccountDescriptor & {
  readonly accessToken: string;
};

export function sentropicDir(): string {
  return join(homedir(), ".sentropic");
}

export function accountsDescriptorPath(dir: string = sentropicDir()): string {
  return join(dir, "accounts.json");
}

export function accountsTokensPath(dir: string = sentropicDir()): string {
  return join(dir, "accounts-tokens.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeSecret(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Descriptor store (no tokens)
// ---------------------------------------------------------------------------

export function loadDescriptors(dir?: string): AccountDescriptor[] {
  return readJson<AccountDescriptor[]>(accountsDescriptorPath(dir)) ?? [];
}

function saveDescriptors(descs: AccountDescriptor[], dir?: string): void {
  writeSecret(accountsDescriptorPath(dir), descs);
}

// ---------------------------------------------------------------------------
// Token store (secrets only — never mixed with descriptors)
// ---------------------------------------------------------------------------

function loadTokenMap(dir?: string): Record<string, string> {
  return readJson<Record<string, string>>(accountsTokensPath(dir)) ?? {};
}

function saveTokenMap(map: Record<string, string>, dir?: string): void {
  writeSecret(accountsTokensPath(dir), map);
}

// ---------------------------------------------------------------------------
// Enroll
// ---------------------------------------------------------------------------

export type EnrollOpts = {
  provider: AccountProvider;
  label: string;
  accessToken: string;
  id?: string;
  dir?: string;
  /** For claude-code: path to the CLI config dir holding credentials (stored as CLAUDE_CONFIG_DIR override). */
  configDir?: string;
};

export type EnrollResult =
  | { ok: true; descriptor: AccountDescriptor }
  | { ok: false; error: string };

export function enrollAccount(opts: EnrollOpts): EnrollResult {
  if (!opts.accessToken.trim()) {
    return { ok: false, error: "access token is empty" };
  }
  const descs = loadDescriptors(opts.dir);
  const id = opts.id ?? `${opts.provider}-${Math.floor(Date.now() / 1000)}`;
  if (descs.some((d) => d.id === id)) {
    return {
      ok: false,
      error: `account "${id}" already enrolled; use --id to specify a unique id`,
    };
  }
  const descriptor: AccountDescriptor = {
    id,
    provider: opts.provider,
    label: opts.label,
    enrolledAt: new Date().toISOString(),
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
  };
  saveDescriptors([...descs, descriptor], opts.dir);
  const tokens = loadTokenMap(opts.dir);
  tokens[id] = opts.accessToken;
  saveTokenMap(tokens, opts.dir);
  return { ok: true, descriptor };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listAccounts(dir?: string): AccountDescriptor[] {
  return loadDescriptors(dir);
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type RemoveResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export function removeAccount(id: string, dir?: string): RemoveResult {
  const descs = loadDescriptors(dir);
  if (!descs.some((d) => d.id === id)) {
    return { ok: false, error: `account "${id}" not found` };
  }
  saveDescriptors(
    descs.filter((d) => d.id !== id),
    dir,
  );
  const tokens = loadTokenMap(dir);
  delete tokens[id];
  saveTokenMap(tokens, dir);
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// Load candidates (descriptor + token) — internal, never surfaced to user
// ---------------------------------------------------------------------------

export function loadCandidates(
  provider?: AccountProvider,
  dir?: string,
): AccountCandidate[] {
  const descs = loadDescriptors(dir);
  const tokens = loadTokenMap(dir);
  return descs
    .filter((d) => !provider || d.provider === provider)
    .flatMap((d) => {
      const accessToken = tokens[d.id];
      if (!accessToken) return [];
      return [{ ...d, accessToken }];
    });
}

// ---------------------------------------------------------------------------
// selectAccount — pure planner (no I/O, no secrets)
//
// Round-robin: given candidate descriptors + the last-used id, returns the
// next descriptor. Advancing past lastUsedId; wraps around.
// ---------------------------------------------------------------------------

export type SelectPolicy = "round-robin";

export function selectAccount(
  candidates: ReadonlyArray<AccountDescriptor>,
  lastUsedId?: string,
  _policy: SelectPolicy = "round-robin",
): AccountDescriptor | undefined {
  if (candidates.length === 0) return undefined;
  if (!lastUsedId) return candidates[0];
  const idx = candidates.findIndex((c) => c.id === lastUsedId);
  if (idx === -1) return candidates[0];
  return candidates[(idx + 1) % candidates.length];
}

// ---------------------------------------------------------------------------
// Sticky binding (Layer-C local stub)
//
// Aligns with SPEC_EVOL_LLM_MESH_ACCOUNT_TRANSPORTS: non-secret affinityKey,
// durable per-session binding, NO silent rebind when account is exhausted.
// A binding created at session launch persists until the session ends or an
// explicit `remote account rm-binding` clears it.
// ---------------------------------------------------------------------------

export type SessionBinding = {
  readonly affinityKey: string;
  readonly accountId: string;
  readonly provider: AccountProvider;
  readonly boundAt: string;
};

export function bindingsPath(dir: string = sentropicDir()): string {
  return join(dir, "session-bindings.json");
}

function loadBindings(dir?: string): Record<string, SessionBinding> {
  return (
    readJson<Record<string, SessionBinding>>(bindingsPath(dir)) ?? {}
  );
}

function saveBindings(
  bindings: Record<string, SessionBinding>,
  dir?: string,
): void {
  writeSecret(bindingsPath(dir), bindings);
}

/** Write (or overwrite) a sticky binding for an affinityKey. */
export function stickyBind(
  affinityKey: string,
  accountId: string,
  provider: AccountProvider,
  dir?: string,
): SessionBinding {
  const bindings = loadBindings(dir);
  const binding: SessionBinding = {
    affinityKey,
    accountId,
    provider,
    boundAt: new Date().toISOString(),
  };
  bindings[affinityKey] = binding;
  saveBindings(bindings, dir);
  return binding;
}

/** Return the binding for affinityKey, or undefined if not yet bound. */
export function lookupBinding(
  affinityKey: string,
  dir?: string,
): SessionBinding | undefined {
  return loadBindings(dir)[affinityKey];
}

/** Return all current sticky bindings (for `remote account bindings`). */
export function listBindings(dir?: string): SessionBinding[] {
  return Object.values(loadBindings(dir));
}

/** Remove a binding (explicit rebind path — not silent). */
export function clearBinding(affinityKey: string, dir?: string): void {
  const bindings = loadBindings(dir);
  delete bindings[affinityKey];
  saveBindings(bindings, dir);
}

// ---------------------------------------------------------------------------
// Quota tracking — exhaustion windows per account
//
// When a CLI session hits a rate-limit / capacity error (429, "too many
// requests", "Claude.ai capacity"), the caller marks the account exhausted
// for a window duration (5h default for Claude Code short-window, 7d for
// weekly). selectAccountWithFallback() skips exhausted accounts and
// falls back across providers when all same-provider accounts are saturated.
// ---------------------------------------------------------------------------

/** Duration presets for quota windows. */
export const QUOTA_WINDOW_5H_MS = 5 * 60 * 60 * 1_000;
export const QUOTA_WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export type QuotaRecord = {
  readonly accountId: string;
  /** ISO-8601 timestamp when exhaustion was declared. */
  readonly exhaustedAt: string;
  /** Window duration in ms. Account is available again after exhaustedAt + windowMs. */
  readonly windowMs: number;
  /** Optional human-readable reason (e.g. "429 rate-limit", "weekly cap"). */
  readonly reason?: string;
};

export function quotaPath(dir: string = sentropicDir()): string {
  return join(dir, "account-quota.json");
}

function loadQuotaMap(dir?: string): Record<string, QuotaRecord> {
  return readJson<Record<string, QuotaRecord>>(quotaPath(dir)) ?? {};
}

function saveQuotaMap(map: Record<string, QuotaRecord>, dir?: string): void {
  writeSecret(quotaPath(dir), map);
}

/** Mark an account as exhausted for `windowMs` milliseconds. */
export function markExhausted(
  accountId: string,
  windowMs: number = QUOTA_WINDOW_5H_MS,
  reason?: string,
  dir?: string,
): QuotaRecord {
  const map = loadQuotaMap(dir);
  const record: QuotaRecord = {
    accountId,
    exhaustedAt: new Date().toISOString(),
    windowMs,
    ...(reason !== undefined ? { reason } : {}),
  };
  map[accountId] = record;
  saveQuotaMap(map, dir);
  return record;
}

/** Clear exhaustion for an account (manual override or after confirmed refresh). */
export function clearExhaustion(accountId: string, dir?: string): void {
  const map = loadQuotaMap(dir);
  delete map[accountId];
  saveQuotaMap(map, dir);
}

/** Prune expired quota records (window elapsed). Returns count removed. */
export function pruneExpiredQuota(nowMs: number = Date.now(), dir?: string): number {
  const map = loadQuotaMap(dir);
  let removed = 0;
  for (const [id, rec] of Object.entries(map)) {
    if (nowMs >= new Date(rec.exhaustedAt).getTime() + rec.windowMs) {
      delete map[id];
      removed++;
    }
  }
  if (removed > 0) saveQuotaMap(map, dir);
  return removed;
}

/** True if the account is currently within its exhaustion window. */
export function isExhausted(
  accountId: string,
  quotaMap: Readonly<Record<string, QuotaRecord>>,
  nowMs: number = Date.now(),
): boolean {
  const rec = quotaMap[accountId];
  if (!rec) return false;
  return nowMs < new Date(rec.exhaustedAt).getTime() + rec.windowMs;
}

/** Enriched view of an account descriptor (for `remote account ls`). */
export type AccountStatus = AccountDescriptor & {
  exhausted: boolean;
  quotaResetsAt?: string;
  /** Reason provided when exhaustion was recorded (e.g. "claude:rate-limited"). */
  exhaustionReason?: string;
};

/** List all accounts with their current quota/exhaustion status. */
export function listAccountsWithStatus(dir?: string): AccountStatus[] {
  const descs = loadDescriptors(dir);
  const quota = loadQuotaMap(dir);
  const now = Date.now();
  return descs.map((d) => {
    const rec = quota[d.id];
    if (!rec) return { ...d, exhausted: false };
    const resetMs = new Date(rec.exhaustedAt).getTime() + rec.windowMs;
    if (now >= resetMs) return { ...d, exhausted: false };
    return {
      ...d,
      exhausted: true,
      quotaResetsAt: new Date(resetMs).toISOString(),
      ...(rec.reason !== undefined ? { exhaustionReason: rec.reason } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// selectAccountWithFallback — quota-aware, cross-provider fallback
//
// Policy (priority order):
//  1. Sticky binding if it exists AND the bound account is not exhausted.
//  2. Round-robin from the preferred provider, skipping exhausted accounts.
//  3. Cross-provider fallback: if ALL preferred-provider accounts are
//     exhausted, try the other provider (claude-code ↔ codex).
//  4. undefined if no usable account exists.
// ---------------------------------------------------------------------------

const FALLBACK_PROVIDER: Record<AccountProvider, AccountProvider> = {
  "claude-code": "codex",
  codex: "claude-code",
};

export type SelectWithFallbackResult =
  | { candidate: AccountCandidate; crossProvider: false }
  | { candidate: AccountCandidate; crossProvider: true; originalProvider: AccountProvider }
  | { candidate: undefined; allExhausted: true };

export function selectAccountWithFallback(
  preferredProvider: AccountProvider,
  affinityKey?: string,
  dir?: string,
  nowMs: number = Date.now(),
): SelectWithFallbackResult {
  pruneExpiredQuota(nowMs, dir);
  const quota = loadQuotaMap(dir);

  // 1. Honour sticky binding if the bound account is still usable.
  if (affinityKey) {
    const binding = lookupBinding(affinityKey, dir);
    if (binding && binding.provider === preferredProvider) {
      if (!isExhausted(binding.accountId, quota, nowMs)) {
        const candidates = loadCandidates(preferredProvider, dir);
        const match = candidates.find((c) => c.id === binding.accountId);
        if (match) return { candidate: match, crossProvider: false };
      }
    }
  }

  // 2. Round-robin from preferred provider, skip exhausted.
  const preferred = loadCandidates(preferredProvider, dir).filter(
    (c) => !isExhausted(c.id, quota, nowMs),
  );
  if (preferred.length > 0) {
    return { candidate: preferred[0]!, crossProvider: false };
  }

  // 3. Cross-provider fallback.
  const fallbackProvider = FALLBACK_PROVIDER[preferredProvider];
  const fallback = loadCandidates(fallbackProvider, dir).filter(
    (c) => !isExhausted(c.id, quota, nowMs),
  );
  if (fallback.length > 0) {
    return {
      candidate: fallback[0]!,
      crossProvider: true,
      originalProvider: preferredProvider,
    };
  }

  return { candidate: undefined, allExhausted: true };
}

// ---------------------------------------------------------------------------
// Credential auto-read helpers
//
// Read the access token from the CLI's own config directory so the user
// doesn't have to copy-paste it manually. Called only when the caller
// explicitly asks (--from-credentials flag) — never automatic.
// ---------------------------------------------------------------------------

export type ReadCredentialResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

/**
 * Read the Claude Code access token from ~/.claude/.credentials.json
 * (or a custom configDir). Returns the claudeAiOauth.accessToken value.
 */
export function readClaudeCredential(
  configDir: string = join(homedir(), ".claude"),
): ReadCredentialResult {
  const path = join(configDir, ".credentials.json");
  const raw = readJson<Record<string, unknown>>(path);
  if (!raw) {
    return { ok: false, error: `credentials file not found or unreadable: ${path}` };
  }
  const oauth = raw["claudeAiOauth"] as Record<string, unknown> | undefined;
  const token = oauth?.["accessToken"];
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, error: `claudeAiOauth.accessToken missing or empty in ${path}` };
  }
  return { ok: true, accessToken: token.trim() };
}

/**
 * Read the Codex / OpenAI API key from ~/.codex/auth.json
 * (or a custom configDir). Returns the OPENAI_API_KEY value.
 */
export function readCodexCredential(
  configDir: string = join(homedir(), ".codex"),
): ReadCredentialResult {
  const path = join(configDir, "auth.json");
  const raw = readJson<Record<string, unknown>>(path);
  if (!raw) {
    return { ok: false, error: `auth file not found or unreadable: ${path}` };
  }
  const key = raw["OPENAI_API_KEY"];
  if (typeof key !== "string" || !key.trim()) {
    return { ok: false, error: `OPENAI_API_KEY missing or empty in ${path}` };
  }
  return { ok: true, accessToken: key.trim() };
}

// ---------------------------------------------------------------------------
// Gateway constants (Layer-B wire — stable per architect spec)
// ---------------------------------------------------------------------------

export const LLM_GATEWAY_URL = "https://llm.sent-tech.ca";

/**
 * Returns the env vars to inject into a session so it routes through the
 * llm-gateway. Requires a valid sentropic S2S DPoP token for pod auth
 * (injected separately by the control-plane auth flow, not here).
 */
export function llmGatewayEnv(): { ANTHROPIC_BASE_URL: string } {
  return { ANTHROPIC_BASE_URL: LLM_GATEWAY_URL };
}

// ---------------------------------------------------------------------------
// Local session log — append-only audit trail of account selections.
//
// Each entry is a single JSONL line in ~/.sentropic/session-log.jsonl (0600).
// Provides a local audit trail; can be exported to S3 later.
// Best-effort: errors are silently swallowed (never block job launch).
// ---------------------------------------------------------------------------

export type SessionLogEntry = {
  at: string;
  /** "launch" = account selected at job start; "exhaust" = account auto-exhausted (throttle). Absent = "launch" (back-compat). */
  kind?: "launch" | "exhaust";
  jobId: string;
  preferredProvider: AccountProvider;
  selectedProvider: AccountProvider;
  accountId: string;
  accountLabel: string;
  crossProvider: boolean;
  /** Throttle signature tag that triggered auto-exhaustion (kind="exhaust" only). */
  signature?: string;
};

export function sessionLogPath(dir: string = sentropicDir()): string {
  return join(dir, "session-log.jsonl");
}

export function appendSessionLogEntry(
  entry: Omit<SessionLogEntry, "at">,
  dir?: string,
): void {
  try {
    const p = sessionLogPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(p, line, { mode: 0o600 });
  } catch {
    // best-effort
  }
}
