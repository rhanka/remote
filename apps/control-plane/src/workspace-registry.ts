/**
 * workspace-registry.ts — Phase A0b
 *
 * Durable JSON file store for WorkspaceEntry records.
 * Persists to DATA_DIR/workspaces.json using write-rename atomicity.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceEntry = {
  wsId: string;         // ws:<hex> durable workspace id
  subPath: string;      // RWX sub-path
  owner: string;        // tenant/user
  lineageIds: string[];
  createdAt: string;    // ISO
  updatedAt: string;    // ISO
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// WorkspaceRegistry
// ---------------------------------------------------------------------------

export class WorkspaceRegistry {
  private readonly filePath: string;
  private readonly store: Map<string, WorkspaceEntry>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.cwd();
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "workspaces.json");
    this.store = new Map();
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const entries = JSON.parse(raw) as WorkspaceEntry[];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          this.store.set(entry.wsId, entry);
        }
      }
    } catch {
      // ENOENT or parse error — start with empty store
    }
  }

  private persist(): void {
    atomicWrite(this.filePath, Array.from(this.store.values()));
  }

  upsertWorkspace(entry: WorkspaceEntry): void {
    this.store.set(entry.wsId, entry);
    this.persist();
  }

  getWorkspace(wsId: string): WorkspaceEntry | undefined {
    return this.store.get(wsId);
  }

  listWorkspaces(owner?: string): WorkspaceEntry[] {
    const all = Array.from(this.store.values());
    if (owner === undefined) {
      return all;
    }
    return all.filter((e) => e.owner === owner);
  }
}
