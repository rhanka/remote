/**
 * llm-mesh — local LLM gateway management for solo-dev mode.
 *
 * Enrollment: `remote llm-mesh enroll codex` reads ~/.codex/auth.json
 *   (supports both raw OPENAI_API_KEY and ChatGPT Pro OAuth JWT) and writes
 *   ~/.sentropic/llm-mesh.json.
 *
 * Startup:    `remote llm-mesh start` reads the config, starts the gateway
 *   (apps/llm-gateway) as a background process, and prints the env vars to
 *   configure Claude Code.
 *
 * Config path: ~/.sentropic/llm-mesh.json  (0600)
 * PID file:    ~/.sentropic/llm-mesh.pid
 * Token file:  ~/.sentropic/llm-mesh-token.json (0600, gw-token for the CLI)
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface LlmMeshAccount {
  id: string;
  /** "anthropic" = Claude sk-ant-; "openai" = OpenAI API key or OAuth JWT */
  provider: "anthropic" | "openai";
  label: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface LlmMeshConfig {
  accounts: LlmMeshAccount[];
  /** Local port for the gateway. Default: 3002 */
  port?: number;
  /** Log file path (stdout+stderr of the gateway process). Default: ~/.sentropic/llm-mesh.log */
  logFile?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function sentropicDir(): string {
  return join(homedir(), ".sentropic");
}

export function llmMeshConfigPath(dir?: string): string {
  return join(dir ?? sentropicDir(), "llm-mesh.json");
}

export function llmMeshPidPath(dir?: string): string {
  return join(dir ?? sentropicDir(), "llm-mesh.pid");
}

export function llmMeshTokenPath(dir?: string): string {
  return join(dir ?? sentropicDir(), "llm-mesh-token.json");
}

export function llmMeshLogPath(config?: LlmMeshConfig, dir?: string): string {
  return config?.logFile ?? join(dir ?? sentropicDir(), "llm-mesh.log");
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeSecret(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readLlmMeshConfig(dir?: string): LlmMeshConfig | null {
  return readJson<LlmMeshConfig>(llmMeshConfigPath(dir));
}

export function writeLlmMeshConfig(config: LlmMeshConfig, dir?: string): void {
  writeSecret(llmMeshConfigPath(dir), config);
}

// ---------------------------------------------------------------------------
// JWT helpers (no signature verification — expiry check only)
// ---------------------------------------------------------------------------

export function jwtExpiry(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string, graceSeconds = 300): boolean {
  const exp = jwtExpiry(token);
  if (!exp) return false; // non-JWT token — assume valid
  return exp.getTime() - graceSeconds * 1000 < Date.now();
}

// ---------------------------------------------------------------------------
// Codex enrollment
// ---------------------------------------------------------------------------

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

/**
 * Read Codex credentials from ~/.codex/auth.json and produce an LlmMeshAccount.
 * Supports:
 *  - OPENAI_API_KEY (raw sk-... key, pay-per-token tier)
 *  - tokens.access_token (ChatGPT Pro OAuth JWT, subscription flat-rate tier)
 */
export function enrollCodexAccount(codexDir?: string): LlmMeshAccount {
  const authPath = join(codexDir ?? join(homedir(), ".codex"), "auth.json");
  const auth = readJson<CodexAuthJson>(authPath);
  if (!auth) {
    throw new Error(`Codex auth file not found or unreadable: ${authPath}`);
  }

  // Raw API key path (standard pay-per-token)
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
    return {
      id: "codex-api",
      provider: "openai",
      label: "Codex (API key)",
      token: auth.OPENAI_API_KEY.trim(),
    };
  }

  // OAuth path (ChatGPT Pro / subscription)
  const accessToken = auth.tokens?.access_token;
  if (!accessToken || !accessToken.trim()) {
    throw new Error(
      `No usable credential in ${authPath}: OPENAI_API_KEY is null/absent ` +
        `and tokens.access_token is missing. Run \`codex auth login\` first.`,
    );
  }

  const expiresAt = jwtExpiry(accessToken);
  const refreshToken = auth.tokens?.refresh_token;

  const account: LlmMeshAccount = {
    id: "codex-oauth",
    provider: "openai",
    label: "Codex (ChatGPT Pro OAuth)",
    token: accessToken.trim(),
  };
  if (refreshToken) account.refreshToken = refreshToken;
  if (expiresAt) account.expiresAt = expiresAt.toISOString();
  return account;
}

// ---------------------------------------------------------------------------
// Token refresh (OAuth — only applicable when refreshToken is present)
// ---------------------------------------------------------------------------

interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Attempt to refresh an account's OAuth access token using its refresh_token.
 * Returns the updated account, or the original if refresh is not applicable
 * (no refresh_token, or already a raw API key).
 */
export async function refreshAccountToken(
  account: LlmMeshAccount,
): Promise<LlmMeshAccount> {
  if (!account.refreshToken) return account;
  if (!isTokenExpired(account.token)) return account;

  const resp = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Token refresh failed (${resp.status}): ${await resp.text()}`,
    );
  }
  const data = (await resp.json()) as RefreshResponse;
  if (!data.access_token) throw new Error("Token refresh: no access_token in response");

  const expiresAt = jwtExpiry(data.access_token);
  return {
    ...account,
    token: data.access_token,
    ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gateway process management
// ---------------------------------------------------------------------------

/**
 * Resolve the gateway entry point relative to this package.
 * Monorepo layout: packages/remote-cli/dist/ → ../../.. → repo root → apps/llm-gateway/dist/index.js
 */
export function gatewayScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(thisFile), "..", "..", "..");
  return join(repoRoot, "apps", "llm-gateway", "dist", "index.js");
}

/** Build GATEWAY_ACCOUNTS from the llm-mesh config accounts */
function buildGatewayAccountsEnv(accounts: LlmMeshAccount[]): string {
  return JSON.stringify(
    accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      label: a.label,
      token: a.token,
      ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
    })),
  );
}

export interface StartResult {
  pid: number;
  port: number;
  gatewayToken: string;
}

/**
 * Start the llm-gateway as a detached background process.
 * Returns the PID, port, and a gw-token for Claude Code.
 */
export async function startGateway(
  config: LlmMeshConfig,
  opts: { readonly verbose?: boolean | undefined } = {},
): Promise<StartResult> {
  const port = config.port ?? 3002;
  const logFile = llmMeshLogPath(config);
  const gatewayScript = gatewayScriptPath();

  if (!existsSync(gatewayScript)) {
    throw new Error(
      `Gateway script not found: ${gatewayScript}\n` +
        `Run \`npm run build -w apps/llm-gateway\` first.`,
    );
  }

  mkdirSync(sentropicDir(), { recursive: true });

  // Refresh expired tokens before launch
  const refreshedAccounts: LlmMeshAccount[] = [];
  for (const acc of config.accounts) {
    try {
      refreshedAccounts.push(await refreshAccountToken(acc));
    } catch (err) {
      if (opts.verbose) {
        process.stderr.write(
          `[remote] llm-mesh: token refresh failed for ${acc.id}: ${String(err)}\n`,
        );
      }
      refreshedAccounts.push(acc);
    }
  }

  const gatewayEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_ACCOUNTS: buildGatewayAccountsEnv(refreshedAccounts),
    PORT: String(port),
  };

  // Start detached, piping stdout+stderr to logFile
  const { openSync } = await import("node:fs");
  const logFd = openSync(logFile, "a");
  const child = spawn("node", [gatewayScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: gatewayEnv,
  });
  child.unref();
  const pid = child.pid!;

  // Write PID file
  writeFileSync(llmMeshPidPath(), String(pid) + "\n");

  // Wait for the gateway to be ready
  const baseUrl = `http://localhost:${port}`;
  await waitForHealth(baseUrl, 10_000);

  // Acquire a session token
  const sessionResp = await fetch(`${baseUrl}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "local-dev" }),
  });
  if (!sessionResp.ok) {
    throw new Error(`Session acquisition failed: ${sessionResp.status}`);
  }
  const session = (await sessionResp.json()) as { gatewayToken?: string };
  const gatewayToken = session.gatewayToken;
  if (!gatewayToken) throw new Error("No gatewayToken in session response");

  // Persist the token (secret)
  writeSecret(llmMeshTokenPath(), { gatewayToken, baseUrl, pid });

  // Persist refreshed tokens back to config
  writeLlmMeshConfig({ ...config, accounts: refreshedAccounts });

  return { pid, port, gatewayToken };
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Gateway did not become healthy within ${timeoutMs}ms`);
}

/** Read the running gateway's PID. Returns null if not running. */
export function readGatewayPid(dir?: string): number | null {
  try {
    const raw = readFileSync(llmMeshPidPath(dir), "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    // Check if the process is still alive
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

interface LlmMeshTokenFile {
  gatewayToken: string;
  baseUrl: string;
  pid: number;
}

/**
 * Returns {ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY} for the running local gateway,
 * or null if not running or token file absent.
 *
 * Used by `remote run` to auto-inject the gateway env into every tmux session
 * (interactive + headless) so all Claude sessions + their subagents use the gateway.
 */
export function readLlmMeshSessionEnv(dir?: string): {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
} | null {
  try {
    const raw = readFileSync(llmMeshTokenPath(dir), "utf8");
    const { gatewayToken, baseUrl, pid } = JSON.parse(raw) as LlmMeshTokenFile;
    if (!gatewayToken || !baseUrl) return null;
    // Verify the gateway process is still alive
    try { process.kill(pid, 0); } catch { return null; }
    return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: gatewayToken };
  } catch {
    return null;
  }
}

/** Stop the running gateway. */
export function stopGateway(dir?: string): { stopped: boolean; pid?: number } {
  const pid = readGatewayPid(dir);
  if (!pid) return { stopped: false };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  try {
    unlinkSync(llmMeshPidPath(dir));
  } catch {
    // best-effort cleanup
  }
  return { stopped: true, pid };
}
