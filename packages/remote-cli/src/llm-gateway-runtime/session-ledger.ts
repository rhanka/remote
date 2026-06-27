import type { AccountDescriptor, PublicAccountDescriptor } from "./accounts.js";
import { publicAccountDescriptor } from "./accounts.js";
import type { RoutingTarget } from "./model-catalog.js";

export interface SessionLedgerEntry {
  gatewaySessionId: string;
  clientSessionId: string;
  workspaceId?: string;
  profile?: string;
  account: PublicAccountDescriptor;
  requestedModel?: string;
  modelId?: string;
  upstreamModel?: string;
  routePolicy?: string;
  routeReason?: string;
  createdAt: string;
  lastUsedAt: string;
  requestCount: number;
}

export interface UpsertSessionLedgerInput {
  gatewaySessionId: string;
  clientSessionId?: string;
  workspaceId?: string;
  profile?: string;
  account: AccountDescriptor;
  route?: RoutingTarget;
  now?: Date;
}

const _ledger = new Map<string, SessionLedgerEntry>();

function timestamp(now = new Date()): string {
  return now.toISOString();
}

function routeFields(route?: RoutingTarget): Partial<SessionLedgerEntry> {
  if (!route) return {};
  return {
    ...(route.requestedModel ? { requestedModel: route.requestedModel } : {}),
    ...(route.catalogModelId ? { modelId: route.catalogModelId } : {}),
    ...(route.upstreamModel ? { upstreamModel: route.upstreamModel } : {}),
    routePolicy: route.routingPolicy,
    routeReason: route.routeReason,
  };
}

export function upsertSessionLedger(
  input: UpsertSessionLedgerInput,
): SessionLedgerEntry {
  const now = timestamp(input.now);
  const existing = _ledger.get(input.gatewaySessionId);
  const workspaceId = input.workspaceId ?? existing?.workspaceId;
  const profile = input.profile ?? existing?.profile;
  const entry: SessionLedgerEntry = {
    gatewaySessionId: input.gatewaySessionId,
    clientSessionId:
      input.clientSessionId ??
      existing?.clientSessionId ??
      input.gatewaySessionId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(profile ? { profile } : {}),
    account: publicAccountDescriptor(input.account),
    ...routeFields(input.route),
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    requestCount: existing?.requestCount ?? 0,
  };
  _ledger.set(entry.gatewaySessionId, entry);
  return entry;
}

export function recordSessionRequest(
  gatewaySessionId: string | undefined,
  route?: RoutingTarget,
  now = new Date(),
): SessionLedgerEntry | undefined {
  if (!gatewaySessionId) return undefined;
  const existing = _ledger.get(gatewaySessionId);
  if (!existing) return undefined;
  const entry: SessionLedgerEntry = {
    ...existing,
    ...routeFields(route),
    lastUsedAt: timestamp(now),
    requestCount: existing.requestCount + 1,
  };
  _ledger.set(gatewaySessionId, entry);
  return entry;
}

export function listSessionLedger(): SessionLedgerEntry[] {
  return [..._ledger.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function getSessionLedgerEntry(
  gatewaySessionId: string,
): SessionLedgerEntry | undefined {
  return _ledger.get(gatewaySessionId);
}

export function resetSessionLedger(): void {
  _ledger.clear();
}
