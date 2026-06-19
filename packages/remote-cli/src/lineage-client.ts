/**
 * lineage-client.ts — Phase A0c
 *
 * Client-side helpers for attaching lineage lease tokens to HTTP requests
 * that mutate workspace state.
 */

/**
 * Returns headers to include in requests that mutate workspace state.
 * Pass undefined to get empty headers (no lineage active).
 *
 * @example
 *   const headers = leaseHeaders(activeLease);
 *   // { "X-Lineage-Id": "lin_...", "X-Lineage-Epoch": "2" }
 *   // or {} when no active lease
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
