import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { findAccount, selectAccount } from "./accounts.js";
import type { AccountDescriptor } from "./accounts.js";

// ─── k8s ConfigMap client ────────────────────────────────────────────────────

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc.cluster.local";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT ?? "443";
const NAMESPACE = process.env.POD_NAMESPACE ?? "sentropic-remote";
const CONFIGMAP_NAME = process.env.STICKY_CONFIGMAP ?? "llm-gateway-sticky";
const LOCAL_STICKY_FILE = process.env.LLM_GATEWAY_STICKY_FILE;

function saToken(): string {
  try {
    return readFileSync(SA_TOKEN_PATH, "utf-8").trim();
  } catch {
    // Fallback for local dev/testing
    return process.env.K8S_TOKEN ?? "";
  }
}

function cmUrl(): string {
  return `https://${K8S_HOST}:${K8S_PORT}/api/v1/namespaces/${NAMESPACE}/configmaps/${CONFIGMAP_NAME}`;
}

function readLocalSticky(): Record<string, string> {
  if (!LOCAL_STICKY_FILE) return {};
  try {
    return JSON.parse(readFileSync(LOCAL_STICKY_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeLocalSticky(data: Record<string, string>): void {
  if (!LOCAL_STICKY_FILE) return;
  mkdirSync(dirname(LOCAL_STICKY_FILE), { recursive: true });
  const tmp = `${LOCAL_STICKY_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, LOCAL_STICKY_FILE);
}

export async function readSticky(): Promise<Record<string, string>> {
  const token = saToken();
  if (!token) return readLocalSticky();
  const resp = await fetch(cmUrl(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error(`sticky ConfigMap read failed: ${resp.status}`);
  const cm = (await resp.json()) as { data?: Record<string, string> };
  return cm.data ?? {};
}

export async function writeSticky(sessionId: string, accountId: string): Promise<void> {
  const token = saToken();
  if (!token) {
    writeLocalSticky({ ...readLocalSticky(), [sessionId]: accountId });
    return;
  }
  const patch = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE },
    data: { [sessionId]: accountId },
  };
  const resp = await fetch(cmUrl(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/strategic-merge-patch+json",
    },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`sticky ConfigMap patch failed: ${resp.status}`);
}

// ─── Restart-safe gateway token derivation ──────────────────────────────────

interface SessionEntry {
  gatewayToken: string;
  accountId: string;
  token: string;
  provider: string;
}

const _sessions = new Map<string, SessionEntry>();
const TOKEN_PREFIX = "gw-v1-";

function tokenSeed(): string {
  const seed = process.env.LLM_GATEWAY_TOKEN_SEED;
  if (!seed) throw new Error("LLM_GATEWAY_TOKEN_SEED env var is required");
  return seed;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unb64url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function macFor(sessionId: string): string {
  return createHmac("sha256", tokenSeed())
    .update("gw-token-v1\0")
    .update(sessionId)
    .digest("base64url");
}

export function gatewayTokenForSession(sessionId: string): string {
  return `${TOKEN_PREFIX}${b64url(sessionId)}.${macFor(sessionId)}`;
}

function sessionIdFromGatewayToken(gatewayToken: string): string | null {
  if (!gatewayToken.startsWith(TOKEN_PREFIX)) return null;
  const rest = gatewayToken.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const encodedSessionId = rest.slice(0, dot);
  const suppliedMac = rest.slice(dot + 1);
  const sessionId = unb64url(encodedSessionId);
  if (!sessionId) return null;
  const expectedMac = macFor(sessionId);
  const a = Buffer.from(suppliedMac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export function sessionCount(): number {
  return _sessions.size;
}

export async function lookupToken(gatewayToken: string): Promise<SessionEntry | undefined> {
  const cached = _sessions.get(gatewayToken);
  if (cached) return cached;

  const sessionId = sessionIdFromGatewayToken(gatewayToken);
  if (!sessionId) return undefined;

  const existing = await readSticky();
  const accountId = existing[sessionId];
  if (accountId === undefined) return undefined;
  const account = findAccount(accountId);
  if (!account) return undefined;

  const entry = {
    gatewayToken,
    accountId: account.id,
    token: account.token,
    provider: account.provider,
  };
  _sessions.set(gatewayToken, entry);
  return entry;
}

/** Update the bearer token for a session after an OAuth refresh. */
export function updateSessionToken(gatewayToken: string, newToken: string): void {
  const entry = _sessions.get(gatewayToken);
  if (entry) (entry as { token: string }).token = newToken;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SessionResult {
  gatewayToken: string;
  accountId: string;
}

/**
 * Acquire or re-acquire a session for a given sessionId.
 * Idempotent: the same sessionId always maps to the same accountId and token.
 * The token is derived from LLM_GATEWAY_TOKEN_SEED + sessionId, never persisted.
 */
export async function acquireSession(sessionId: string): Promise<SessionResult> {
  // Check ConfigMap for existing sticky binding
  const existing = await readSticky();
  let account: AccountDescriptor;

  const boundId = existing[sessionId];
  if (boundId !== undefined) {
    const found = findAccount(boundId);
    if (!found) throw new Error(`sticky account ${boundId} not found in GATEWAY_ACCOUNTS`);
    account = found;
  } else {
    account = selectAccount();
    await writeSticky(sessionId, account.id);
  }

  const gatewayToken = gatewayTokenForSession(sessionId);
  _sessions.set(gatewayToken, {
    gatewayToken,
    accountId: account.id,
    token: account.token,
    provider: account.provider,
  });

  return { gatewayToken, accountId: account.id };
}
