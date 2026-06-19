/**
 * lineage-lease.ts — control-plane copy of Phase A0a module
 *
 * Pure module: lineage identity + lease/epoch/fencing.
 * No pods, no sync, no secrets, no kubectl. Only node:fs / node:path / node:crypto.
 *
 * This is a verbatim copy of packages/remote-cli/src/lineage-lease.ts kept in
 * sync manually. The remote-cli package does not expose these functions through
 * its public package exports (it is a CLI binary), so the control-plane owns
 * its own copy.
 *
 * Invariants
 * ----------
 * - Every mutating lease operation verifies epoch === expectedEpoch.
 *   A stale epoch is rejected — no exception, typed error return.
 * - Write-rename atomicity: write to <file>.tmp then renameSync to <file>.
 *   Atomicity relies on POSIX rename (best-effort on NFS).
 * - No external dependencies.
 *
 * Root path
 * ---------
 * All files live under `root` (default: process.cwd()).
 *   Leases:   <root>/.remote/leases/<lineageId>.json
 *   Lineages: <root>/.remote/lineages/<lineageId>.json
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque lineage identity: `lin_<uuidv7-style>`. Struck once, persisted, derived from nothing. */
export type LineageId = `lin_${string}`;

/**
 * Full lineage record persisted in `.remote/lineages/<id>.json`.
 * One file per lineage — supports multiple sessions / fanout on the same workspace.
 */
export interface LineageRecord {
  lineage: LineageId;
  profile: string; // "claude" | "codex" | "agy" | ...
  kind: "local" | "remote";
  incarnation: {
    local: { tmux: string; pid: number } | null;
    remote: { sessionId: string } | null;
  };
  /** ws:<hex> values accumulated over the lineage's lifetime (one per ws move) */
  wsHistory: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/**
 * Lease record persisted in `.remote/leases/<lineageId>.json`.
 * `epoch` is the fencing token: every mutation must present the current epoch.
 */
export interface LineageLease {
  lineageId: LineageId;
  /** Monotone fencing token — incremented on handoff, rejected when stale. */
  epoch: number;
  /** Instance id of the current holder, e.g. "claude:remote:181cda7ac333". */
  holder: string;
  /** Tmux slug (local) or sessionId (remote). */
  incarnationId: string;
  location: "local" | "remote";
  /** ISO timestamp after which this lease is considered expired. */
  expiresAt: string;
}

// Typed error returns — never throw, always return.

export type AcquireResult =
  | LineageLease
  | { error: "conflict"; current: LineageLease };

export type RenewResult =
  | LineageLease
  | { error: "stale_epoch" | "not_holder" };

export type HandoffResult =
  | LineageLease
  | { error: "stale_epoch" | "not_holder" };

export type ReleaseResult = void | { error: "stale_epoch" | "not_holder" };

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function leasesDir(root: string): string {
  return join(root, ".remote", "leases");
}

function lineagesDir(root: string): string {
  return join(root, ".remote", "lineages");
}

function leaseFile(root: string, lineageId: LineageId): string {
  return join(leasesDir(root), `${lineageId}.json`);
}

function lineageFile(root: string, lineageId: LineageId): string {
  return join(lineagesDir(root), `${lineageId}.json`);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write: serialize to JSON, write to <path>.tmp, then rename to <path>.
 * Relies on POSIX rename semantics (best-effort on NFS).
 */
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lease operations
// ---------------------------------------------------------------------------

/**
 * Read the current lease for a lineage without mutating it.
 */
export function readLease(
  lineageId: LineageId,
  root = process.cwd(),
): LineageLease | null {
  return readJson<LineageLease>(leaseFile(root, lineageId));
}

/**
 * Returns true when the lease's `expiresAt` is in the past.
 */
export function isLeaseExpired(lease: LineageLease): boolean {
  return new Date(lease.expiresAt).getTime() <= Date.now();
}

/**
 * Acquire (or take over an expired) lease.
 *
 * - If no lease exists → creates one at epoch 0.
 * - If the existing lease is expired → takes over, keeps epoch (no increment).
 * - If the existing lease is held and not expired → returns { error: "conflict" }.
 */
export function acquireLease(
  lineageId: LineageId,
  holder: string,
  incarnationId: string,
  location: "local" | "remote",
  ttlMs: number,
  root = process.cwd(),
): AcquireResult {
  ensureDir(leasesDir(root));

  const existing = readLease(lineageId, root);

  if (existing !== null && !isLeaseExpired(existing)) {
    return { error: "conflict", current: existing };
  }

  const epoch = existing?.epoch ?? 0;
  const lease: LineageLease = {
    lineageId,
    epoch,
    holder,
    incarnationId,
    location,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  atomicWrite(leaseFile(root, lineageId), lease);
  return lease;
}

/**
 * Renew a held lease (push expiry forward).
 *
 * Rejects with `stale_epoch` when expectedEpoch !== current epoch.
 * Rejects with `not_holder` when holder doesn't match.
 */
export function renewLease(
  lineageId: LineageId,
  holder: string,
  expectedEpoch: number,
  ttlMs: number,
  root = process.cwd(),
): RenewResult {
  const current = readLease(lineageId, root);
  if (current === null) {
    return { error: "stale_epoch" };
  }
  if (current.epoch !== expectedEpoch) {
    return { error: "stale_epoch" };
  }
  if (current.holder !== holder) {
    return { error: "not_holder" };
  }

  const renewed: LineageLease = {
    ...current,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  atomicWrite(leaseFile(root, lineageId), renewed);
  return renewed;
}

/**
 * Hand off the lease from one holder to another.
 *
 * Increments epoch (+1) on success — the old epoch is now invalid for any
 * mutation (fencing: the old holder becomes a zombie and will be rejected on
 * any future renew/handoff/release attempt).
 *
 * Rejects with `stale_epoch` when expectedEpoch !== current epoch.
 * Rejects with `not_holder` when fromHolder doesn't match.
 */
export function handoffLease(
  lineageId: LineageId,
  fromHolder: string,
  expectedEpoch: number,
  toHolder: string,
  toIncarnationId: string,
  toLocation: "local" | "remote",
  ttlMs: number,
  root = process.cwd(),
): HandoffResult {
  const current = readLease(lineageId, root);
  if (current === null) {
    return { error: "stale_epoch" };
  }
  if (current.epoch !== expectedEpoch) {
    return { error: "stale_epoch" };
  }
  if (current.holder !== fromHolder) {
    return { error: "not_holder" };
  }

  const next: LineageLease = {
    lineageId,
    epoch: current.epoch + 1,
    holder: toHolder,
    incarnationId: toIncarnationId,
    location: toLocation,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  atomicWrite(leaseFile(root, lineageId), next);
  return next;
}

/**
 * Release (delete) a held lease.
 *
 * Rejects with `stale_epoch` when expectedEpoch !== current epoch.
 * Rejects with `not_holder` when holder doesn't match.
 * No-ops if the lease file doesn't exist (idempotent on double-release).
 */
export function releaseLease(
  lineageId: LineageId,
  holder: string,
  expectedEpoch: number,
  root = process.cwd(),
): ReleaseResult {
  const current = readLease(lineageId, root);
  if (current === null) {
    // Already gone — idempotent.
    return;
  }
  if (current.epoch !== expectedEpoch) {
    return { error: "stale_epoch" };
  }
  if (current.holder !== holder) {
    return { error: "not_holder" };
  }

  rmSync(leaseFile(root, lineageId), { force: true });
}

// ---------------------------------------------------------------------------
// Lineage record CRUD
// ---------------------------------------------------------------------------

/**
 * Generate a fresh `lin_<uuid>` lineage id. Uses crypto.randomUUID() (v4),
 * prefixed with "lin_".
 */
function newLineageId(): LineageId {
  return `lin_${randomUUID().replace(/-/g, "")}` as LineageId;
}

/**
 * Create and persist a new LineageRecord.
 * Does NOT create a lease — that is a separate step.
 */
export function createLineage(
  profile: string,
  kind: "local" | "remote",
  wsHex: string,
  root = process.cwd(),
): LineageRecord {
  ensureDir(lineagesDir(root));

  const now = new Date().toISOString();
  const record: LineageRecord = {
    lineage: newLineageId(),
    profile,
    kind,
    incarnation: {
      local: null,
      remote: null,
    },
    wsHistory: [wsHex],
    createdAt: now,
    updatedAt: now,
  };

  atomicWrite(lineageFile(root, record.lineage), record);
  return record;
}

/**
 * Read a lineage record by id.
 */
export function readLineage(
  lineageId: LineageId,
  root = process.cwd(),
): LineageRecord | null {
  return readJson<LineageRecord>(lineageFile(root, lineageId));
}

/**
 * Patch a lineage record. `updatedAt` is always refreshed.
 * Throws if the lineage doesn't exist.
 */
export function updateLineage(
  lineageId: LineageId,
  patch: Partial<Omit<LineageRecord, "lineage" | "createdAt">>,
  root = process.cwd(),
): LineageRecord {
  const existing = readLineage(lineageId, root);
  if (existing === null) {
    throw new Error(`lineage not found: ${lineageId}`);
  }

  const updated: LineageRecord = {
    ...existing,
    ...patch,
    lineage: existing.lineage, // immutable
    createdAt: existing.createdAt, // immutable
    updatedAt: new Date().toISOString(),
  };

  atomicWrite(lineageFile(root, lineageId), updated);
  return updated;
}

/**
 * List all lineage records under <root>/.remote/lineages/.
 * Returns an empty array if the directory doesn't exist yet.
 */
export function listLineages(root = process.cwd()): LineageRecord[] {
  const dir = lineagesDir(root);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: LineageRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const rec = readJson<LineageRecord>(join(dir, entry));
    if (rec !== null) {
      results.push(rec);
    }
  }
  return results;
}
