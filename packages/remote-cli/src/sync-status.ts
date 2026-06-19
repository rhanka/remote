import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SyncState = "synced" | "pending" | "degraded" | "blocked";

export type ClassMetrics = {
  pendingBytes: number;
  pendingCount: number;
  oldestPendingAge: number; // seconds, 0 if none pending
  lastAckedAt: string | null; // ISO8601
  estimatedCatchup: number; // seconds
};

export type SyncStatus = {
  state: SyncState;
  safeToClose: boolean;
  updatedAt: string;
  conv: ClassMetrics;
  hot: ClassMetrics;
  cold: ClassMetrics;
};

export function syncStatusPath(sessionId: string): string {
  return join(homedir(), ".remote", "sync-status", `${sessionId}.json`);
}

export function readSyncStatus(sessionId: string): SyncStatus | null {
  const p = syncStatusPath(sessionId);
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SyncStatus;
  } catch {
    return null;
  }
}

export function writeSyncStatus(sessionId: string, status: SyncStatus): void {
  const p = syncStatusPath(sessionId);
  mkdirSync(join(homedir(), ".remote", "sync-status"), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
  renameSync(tmp, p);
}

export function emptyMetrics(): ClassMetrics {
  return {
    pendingBytes: 0,
    pendingCount: 0,
    oldestPendingAge: 0,
    lastAckedAt: null,
    estimatedCatchup: 0,
  };
}

export function mergedState(classes: SyncState[]): SyncState {
  if (classes.includes("blocked")) return "blocked";
  if (classes.includes("degraded")) return "degraded";
  if (classes.includes("pending")) return "pending";
  return "synced";
}
