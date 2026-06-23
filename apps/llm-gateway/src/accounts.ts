export interface AccountDescriptor {
  id: string;
  provider: string;
  label: string;
  token: string;
  expiresAt?: string;
}

function parse(): AccountDescriptor[] {
  const raw = process.env.GATEWAY_ACCOUNTS;
  if (!raw) throw new Error("GATEWAY_ACCOUNTS env var is required");
  const list = JSON.parse(raw) as unknown;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("GATEWAY_ACCOUNTS must be a non-empty JSON array");
  return list as AccountDescriptor[];
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
