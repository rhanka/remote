import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionDescriptor } from "@sentropic/remote-protocol";

type PersistedStore = {
  sessions: Record<string, SessionDescriptor>;
  owners: Record<string, string>;
};

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

/**
 * Session registry partitioned by owner (the authenticated `userId`).
 * Persists to DATA_DIR/sessions.json on every mutation so the control-plane
 * survives restarts without forgetting running sessions (pods outlive the CP).
 * Loaded sessions are marked with `status: "unknown"` so the CLI knows they
 * need reconciliation before trusting the state.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionDescriptor>();
  private readonly owners = new Map<string, string>();
  private readonly filePath: string | undefined;

  constructor(dataDir?: string) {
    if (dataDir !== undefined) {
      mkdirSync(dataDir, { recursive: true });
      this.filePath = join(dataDir, "sessions.json");
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedStore;
      for (const [id, desc] of Object.entries(raw.sessions ?? {})) {
        this.sessions.set(id, desc as SessionDescriptor);
      }
      for (const [id, owner] of Object.entries(raw.owners ?? {})) {
        this.owners.set(id, owner);
      }
    } catch {
      // Corrupt file — start fresh; the next mutation will overwrite it.
    }
  }

  private saveToDisk(): void {
    if (!this.filePath) return;
    const data: PersistedStore = {
      sessions: Object.fromEntries(this.sessions),
      owners: Object.fromEntries(this.owners),
    };
    try {
      atomicWrite(this.filePath, data);
    } catch {
      // Best-effort: disk full / permission error must not crash the CP.
    }
  }

  put(descriptor: SessionDescriptor, userId?: string): SessionDescriptor {
    this.sessions.set(descriptor.id, descriptor);
    if (userId !== undefined) this.owners.set(descriptor.id, userId);
    this.saveToDisk();
    return descriptor;
  }

  get(id: string, userId?: string): SessionDescriptor | undefined {
    if (userId !== undefined && this.owners.get(id) !== userId) return undefined;
    return this.sessions.get(id);
  }

  list(userId?: string): SessionDescriptor[] {
    const all = [...this.sessions.values()];
    if (userId === undefined) return all;
    return all.filter((d) => this.owners.get(d.id) === userId);
  }

  /** Find a single session whose displayName matches `name` (case-insensitive).
   * Returns undefined when there is no match or multiple matches (ambiguous). */
  getByDisplayName(
    name: string,
    userId?: string,
  ): SessionDescriptor | undefined {
    const candidates = this.list(userId).filter(
      (d) => d.displayName?.toLowerCase() === name.toLowerCase(),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  delete(id: string, userId?: string): boolean {
    if (userId !== undefined && this.owners.get(id) !== userId) return false;
    this.owners.delete(id);
    const deleted = this.sessions.delete(id);
    if (deleted) this.saveToDisk();
    return deleted;
  }
}
