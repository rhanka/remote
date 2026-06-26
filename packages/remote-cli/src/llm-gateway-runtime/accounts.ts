export interface AccountDescriptor {
  id: string;
  provider: string;
  label: string;
  token: string;
  authType?: "api-key" | "bearer";
  refreshToken?: string;
  expiresAt?: string;
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

// Visible for testing
export function resetAccountsCache(): void {
  _accounts = null;
}

let _rrIdx = 0;
export function selectAccount(): AccountDescriptor {
  const accounts = getAccounts();
  const acct = accounts[_rrIdx % accounts.length]!;
  _rrIdx++;
  return acct;
}

export function findAccount(accountId: string): AccountDescriptor | undefined {
  return getAccounts().find((a) => a.id === accountId);
}

/** Update the in-memory token for an account (after OAuth refresh). */
export function updateAccountToken(accountId: string, newToken: string, expiresAt?: string): void {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  (acc as { token: string }).token = newToken;
  if (expiresAt !== undefined) (acc as { expiresAt?: string }).expiresAt = expiresAt;
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
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    if (typeof payload.exp === "number") return new Date(payload.exp * 1000).toISOString();
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Refresh the OAuth access token for an account using its refresh_token.
 * Updates the in-memory account on success. No-op if no refresh_token.
 * Returns the new token, or null if refresh is not applicable.
 */
export async function refreshOAuthToken(accountId: string): Promise<string | null> {
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
    console.error(`[llm-gateway] OAuth refresh network error for ${accountId}:`, err);
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`[llm-gateway] OAuth refresh failed (${resp.status}) for ${accountId}: ${body}`);
    return null;
  }

  const data = (await resp.json()) as OAuthRefreshResponse;
  if (!data.access_token) {
    console.error(`[llm-gateway] OAuth refresh: no access_token in response for ${accountId}`);
    return null;
  }

  const expiresAt = jwtExpiry(data.access_token);
  updateAccountToken(accountId, data.access_token, expiresAt);
  console.log(`[llm-gateway] OAuth token refreshed for ${accountId}${expiresAt ? `, expires ${expiresAt}` : ""}`);
  return data.access_token;
}
