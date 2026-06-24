import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { findAccount, selectAccount } from "./accounts.js";
import type { AccountDescriptor } from "./accounts.js";

// ─── k8s ConfigMap client ────────────────────────────────────────────────────

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc.cluster.local";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT ?? "443";
const NAMESPACE = process.env.POD_NAMESPACE ?? "sentropic-remote";
const CONFIGMAP_NAME = process.env.STICKY_CONFIGMAP ?? "llm-gateway-sticky";

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

export async function readSticky(): Promise<Record<string, string>> {
  const token = saToken();
  if (!token) return {};
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
  if (!token) return; // No k8s in local dev — skip write
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

// ─── In-memory token map (survives only until gateway restart) ────────────────

interface SessionEntry {
  gatewayToken: string;
  accountId: string;
  token: string;
  provider: string;
}

const _sessions = new Map<string, SessionEntry>();

export function sessionCount(): number {
  return _sessions.size;
}

export function lookupToken(gatewayToken: string): SessionEntry | undefined {
  return _sessions.get(gatewayToken);
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
 * Idempotent: the same sessionId always maps to the same accountId (ConfigMap).
 * Generates a new gatewayToken on each call (tokens are in-memory only).
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

  const gatewayToken = "gw-" + randomBytes(16).toString("hex");
  _sessions.set(gatewayToken, {
    gatewayToken,
    accountId: account.id,
    token: account.token,
    provider: account.provider,
  });

  return { gatewayToken, accountId: account.id };
}
