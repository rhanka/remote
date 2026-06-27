import {
  accountPoolForProvider,
  listModelCatalog,
  resolveModelRoute,
  type ModelCatalogEntry,
  type RoutingTarget,
} from "./model-catalog.js";

export interface AccountDescriptor {
  id: string;
  provider: string;
  label: string;
  token: string;
  authType?: "api-key" | "bearer";
  refreshToken?: string;
  expiresAt?: string;
  modelIds?: string[];
  models?: string[];
  status?: "active" | "disabled";
}

export interface PublicAccountDescriptor {
  id: string;
  provider: string;
  label: string;
  authType?: AccountDescriptor["authType"];
  expiresAt?: string;
  modelIds: string[];
  status: "active" | "disabled";
}

function isUnsupportedClaudeOAuthAccount(account: AccountDescriptor): boolean {
  return (
    account.provider === "anthropic" &&
    (account.authType === "bearer" ||
      account.id === "claude-oauth" ||
      account.token.startsWith("sk-ant-oat"))
  );
}

function parse(): AccountDescriptor[] {
  const raw = process.env.GATEWAY_ACCOUNTS;
  if (!raw) throw new Error("GATEWAY_ACCOUNTS env var is required");
  const list = JSON.parse(raw) as unknown;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("GATEWAY_ACCOUNTS must be a non-empty JSON array");
  const accounts = (list as AccountDescriptor[]).filter(
    (account) => !isUnsupportedClaudeOAuthAccount(account),
  );
  if (accounts.length === 0) {
    throw new Error(
      "GATEWAY_ACCOUNTS has no supported accounts: Claude Code OAuth is not a supported upstream transport",
    );
  }
  return accounts;
}

let _accounts: AccountDescriptor[] | null = null;
export function getAccounts(): AccountDescriptor[] {
  if (!_accounts) _accounts = parse();
  return _accounts;
}

function accountStatus(account: AccountDescriptor): "active" | "disabled" {
  return account.status ?? "active";
}

function explicitModelIds(account: AccountDescriptor): string[] {
  return [...new Set([...(account.modelIds ?? []), ...(account.models ?? [])])];
}

export function publicAccountDescriptor(
  account: AccountDescriptor,
): PublicAccountDescriptor {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    ...(account.authType ? { authType: account.authType } : {}),
    ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
    modelIds: explicitModelIds(account),
    status: accountStatus(account),
  };
}

export function listAccountDescriptors(): PublicAccountDescriptor[] {
  return getAccounts().map(publicAccountDescriptor);
}

export type AccountProviderFamily = "anthropic" | "openai" | "other";

export function providerFamily(provider: string): AccountProviderFamily {
  if (provider === "openai" || provider === "codex") return "openai";
  if (provider === "anthropic" || provider === "claude-code")
    return "anthropic";
  return "other";
}

export const DEFAULT_QUOTA_EXHAUSTION_MS = 5 * 60 * 60 * 1000;

type ExhaustionRecord = {
  exhaustedAtMs: number;
  windowMs: number;
  reason?: string;
};

const _exhausted = new Map<string, ExhaustionRecord>();

function quotaExhaustionWindowMs(): number {
  const configured = Number.parseInt(
    process.env.LLM_GATEWAY_QUOTA_EXHAUSTION_MS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_QUOTA_EXHAUSTION_MS;
}

export function markAccountExhausted(
  accountId: string,
  reason?: string,
  windowMs: number = quotaExhaustionWindowMs(),
  nowMs: number = Date.now(),
): void {
  _exhausted.set(accountId, {
    exhaustedAtMs: nowMs,
    windowMs,
    ...(reason !== undefined ? { reason } : {}),
  });
}

export function isAccountExhausted(
  accountId: string,
  nowMs: number = Date.now(),
): boolean {
  const rec = _exhausted.get(accountId);
  if (!rec) return false;
  if (nowMs >= rec.exhaustedAtMs + rec.windowMs) {
    _exhausted.delete(accountId);
    return false;
  }
  return true;
}

export function accountExhaustionReason(accountId: string): string | undefined {
  return _exhausted.get(accountId)?.reason;
}

// Visible for testing
export function resetAccountsCache(): void {
  _accounts = null;
  _rrIdx = 0;
  _routeRrIdx.clear();
  _exhausted.clear();
}

let _rrIdx = 0;
const _routeRrIdx = new Map<string, number>();

export function accountSupportsRoute(
  account: AccountDescriptor,
  route: RoutingTarget,
): boolean {
  if (accountStatus(account) !== "active") return false;
  if (isAccountExhausted(account.id)) return false;
  if (accountPoolForProvider(account.provider) !== route.accountPool)
    return false;

  const modelIds = explicitModelIds(account);
  if (modelIds.length === 0) return true;

  const accepted = [
    route.requestedModel,
    route.catalogModelId,
    route.upstreamModel,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return accepted.some((modelId) => modelIds.includes(modelId));
}

export function eligibleAccountsForRoute(
  route?: RoutingTarget,
): AccountDescriptor[] {
  const accounts = getAccounts().filter(
    (account) =>
      accountStatus(account) === "active" && !isAccountExhausted(account.id),
  );
  if (!route) return accounts;
  return accounts.filter((account) => accountSupportsRoute(account, route));
}

export function selectAccount(): AccountDescriptor {
  const accounts = getAccounts();
  const usable = eligibleAccountsForRoute();
  const pool = usable.length > 0 ? usable : accounts;
  const acct = pool[_rrIdx % pool.length]!;
  _rrIdx++;
  return acct;
}

export function selectAccountForRoute(route: RoutingTarget): AccountDescriptor {
  const accounts = eligibleAccountsForRoute(route);
  if (accounts.length === 0) {
    throw new Error(
      `no eligible ${route.accountPool} account for ${route.requestedModel ?? route.upstreamModel ?? "route"}`,
    );
  }
  const key = `${route.accountPool}:${route.upstreamModel ?? route.catalogModelId ?? ""}`;
  const idx = _routeRrIdx.get(key) ?? 0;
  const acct = accounts[idx % accounts.length]!;
  _routeRrIdx.set(key, idx + 1);
  return acct;
}

export function findAccount(accountId: string): AccountDescriptor | undefined {
  return getAccounts().find((a) => a.id === accountId);
}

export function listRoutableModels(): ModelCatalogEntry[] {
  const accounts = getAccounts();
  return listModelCatalog().filter((entry) => {
    const route = resolveModelRoute(entry.id);
    return (
      route !== undefined &&
      accounts.some((account) => accountSupportsRoute(account, route))
    );
  });
}

export function selectFallbackAccount(
  exhaustedAccountId: string,
  nowMs: number = Date.now(),
): AccountDescriptor | undefined {
  let accounts: AccountDescriptor[];
  try {
    accounts = getAccounts();
  } catch {
    return undefined;
  }
  const exhausted = accounts.find((a) => a.id === exhaustedAccountId);
  const candidates = accounts.filter(
    (a) =>
      a.id !== exhaustedAccountId &&
      accountStatus(a) === "active" &&
      !isAccountExhausted(a.id, nowMs),
  );
  if (candidates.length === 0) return undefined;

  const family = exhausted ? providerFamily(exhausted.provider) : undefined;
  const sameFamily = family
    ? candidates.filter((a) => providerFamily(a.provider) === family)
    : [];
  return sameFamily[0] ?? candidates[0];
}

/** Update the in-memory token for an account (after OAuth refresh). */
export function updateAccountToken(
  accountId: string,
  newToken: string,
  expiresAt?: string,
): void {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  (acc as { token: string }).token = newToken;
  if (expiresAt !== undefined)
    (acc as { expiresAt?: string }).expiresAt = expiresAt;
}

// ---------------------------------------------------------------------------
// OAuth token refresh (ChatGPT Pro / OpenAI OAuth flow)
// ---------------------------------------------------------------------------

interface OAuthRefreshResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

function jwtExpiry(token: string): string | undefined {
  try {
    const parts = token.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: number };
    if (typeof payload.exp === "number")
      return new Date(payload.exp * 1000).toISOString();
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Refresh the OAuth access token for an account using its refresh_token.
 * Updates the in-memory account on success. No-op if no refresh_token.
 * Returns the new token, or null if refresh is not applicable.
 */
export async function refreshOAuthToken(
  accountId: string,
): Promise<string | null> {
  const acc = findAccount(accountId);
  if (!acc?.refreshToken) return null;

  let resp: Response;
  try {
    resp = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: acc.refreshToken,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      }),
    });
  } catch (err) {
    console.error(
      `[llm-gateway] OAuth refresh network error for ${accountId}:`,
      err,
    );
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[llm-gateway] OAuth refresh failed (${resp.status}) for ${accountId}: ${body}`,
    );
    return null;
  }

  const data = (await resp.json()) as OAuthRefreshResponse;
  if (!data.access_token) {
    console.error(
      `[llm-gateway] OAuth refresh: no access_token in response for ${accountId}`,
    );
    return null;
  }

  const expiresAt = jwtExpiry(data.access_token);
  updateAccountToken(accountId, data.access_token, expiresAt);
  console.log(
    `[llm-gateway] OAuth token refreshed for ${accountId}${expiresAt ? `, expires ${expiresAt}` : ""}`,
  );
  return data.access_token;
}
