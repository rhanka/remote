/**
 * lineage-client.ts — Phase A0c
 *
 * Client-side helpers for the lineage-lease system:
 *   - leaseHeaders(): attaches fencing token to mutating HTTP requests
 *   - HTTP client functions for acquire/renew/handoff/release/read via the CP
 */

import { authHeaders } from "./config.js";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

// ---------------------------------------------------------------------------
// Types (mirroring the CP's LineageLease shape)
// ---------------------------------------------------------------------------

export type LeaseLocation = "local" | "remote";

export type LineageLease = {
  lineageId: string;
  epoch: number;
  holder: string;
  incarnationId: string;
  location: LeaseLocation;
  expiresAt: string;
};

// ---------------------------------------------------------------------------
// Header helper
// ---------------------------------------------------------------------------

/**
 * Returns headers to include in requests that mutate workspace state.
 * Pass undefined to get empty headers (no lineage active).
 */
export function leaseHeaders(
  lease: { lineageId: string; epoch: number } | undefined,
): Record<string, string> {
  if (!lease) return {};
  return {
    "X-Lineage-Id": lease.lineageId,
    "X-Lineage-Epoch": String(lease.epoch),
  };
}

// ---------------------------------------------------------------------------
// HTTP client — calls the CP /lineage-leases routes
// ---------------------------------------------------------------------------

/**
 * Acquire (or take over an expired) lineage lease.
 * Returns the lease on success, or { error: "conflict", current } on 409.
 */
export async function acquireLineageLease(
  baseUrl: string,
  body: {
    lineageId: string;
    holder: string;
    incarnationId: string;
    location: LeaseLocation;
    ttlMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<LineageLease | { error: "conflict"; current: LineageLease }> {
  const res = await fetchImpl(joinUrl(baseUrl, "/lineage-leases/acquire"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 409) {
    return { error: "conflict", current: json["current"] as LineageLease };
  }
  if (!res.ok) {
    throw new Error(`acquireLineageLease: ${res.status} ${res.statusText}`);
  }
  return json as LineageLease;
}

/**
 * Renew a held lease (push the expiry forward).
 * Returns the updated lease, or { error: "stale_epoch" } on 409.
 */
export async function renewLineageLease(
  baseUrl: string,
  lineageId: string,
  body: { holder: string; expectedEpoch: number; ttlMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<LineageLease | { error: "stale_epoch" }> {
  const res = await fetchImpl(
    joinUrl(baseUrl, `/lineage-leases/${encodeURIComponent(lineageId)}/renew`),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 409) {
    return { error: json["error"] as "stale_epoch" };
  }
  if (!res.ok) {
    throw new Error(`renewLineageLease: ${res.status} ${res.statusText}`);
  }
  return json as LineageLease;
}

/**
 * Hand off a lease to a new holder (increments epoch — fencing token advances).
 * Returns the updated lease, or { error: "stale_epoch" } on 409.
 */
export async function handoffLineageLease(
  baseUrl: string,
  lineageId: string,
  body: {
    fromHolder: string;
    expectedEpoch: number;
    toHolder: string;
    toIncarnationId: string;
    toLocation: LeaseLocation;
    ttlMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<LineageLease | { error: "stale_epoch" }> {
  const res = await fetchImpl(
    joinUrl(
      baseUrl,
      `/lineage-leases/${encodeURIComponent(lineageId)}/handoff`,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 409) {
    return { error: json["error"] as "stale_epoch" };
  }
  if (!res.ok) {
    throw new Error(`handoffLineageLease: ${res.status} ${res.statusText}`);
  }
  return json as LineageLease;
}

/**
 * Release (delete) a held lease.
 * Idempotent — a second call after release does not throw.
 */
export async function releaseLineageLease(
  baseUrl: string,
  lineageId: string,
  body: { holder: string; expectedEpoch: number },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    joinUrl(baseUrl, `/lineage-leases/${encodeURIComponent(lineageId)}`),
    {
      method: "DELETE",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok && res.status !== 409) {
    throw new Error(`releaseLineageLease: ${res.status} ${res.statusText}`);
  }
}

/**
 * Read the current lease without mutating it.
 * Returns null when no lease exists (404).
 */
export async function readLineageLease(
  baseUrl: string,
  lineageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LineageLease | null> {
  const res = await fetchImpl(
    joinUrl(baseUrl, `/lineage-leases/${encodeURIComponent(lineageId)}`),
    {
      method: "GET",
      headers: { ...authHeaders() },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`readLineageLease: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as LineageLease;
}
