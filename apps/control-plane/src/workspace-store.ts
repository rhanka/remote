import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceDescriptor } from "@sentropic/remote-protocol";

type PersistedWorkspaceStore = {
  workspaces: Record<string, WorkspaceDescriptor>;
  owners: Record<string, string>;
  namespaces: Record<string, string>;
};

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

/**
 * Workspace registry partitioned by owner. Persists to
 * DATA_DIR/cp-workspaces.json on every mutation so the control-plane
 * survives restarts without losing workspace registrations.
 */
export class WorkspaceStore {
  private readonly workspaces = new Map<string, WorkspaceDescriptor>();
  private readonly owners = new Map<string, string>();
  private readonly namespaces = new Map<string, string>();
  private readonly filePath: string | undefined;

  constructor(dataDir?: string) {
    if (dataDir !== undefined) {
      mkdirSync(dataDir, { recursive: true });
      this.filePath = join(dataDir, "cp-workspaces.json");
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as PersistedWorkspaceStore;
      for (const [id, desc] of Object.entries(raw.workspaces ?? {})) {
        this.workspaces.set(id, desc as WorkspaceDescriptor);
      }
      for (const [id, owner] of Object.entries(raw.owners ?? {})) {
        this.owners.set(id, owner);
      }
      for (const [id, ns] of Object.entries(raw.namespaces ?? {})) {
        this.namespaces.set(id, ns);
      }
    } catch {
      // Corrupt file — start fresh; next mutation overwrites.
    }
  }

  private saveToDisk(): void {
    if (!this.filePath) return;
    const data: PersistedWorkspaceStore = {
      workspaces: Object.fromEntries(this.workspaces),
      owners: Object.fromEntries(this.owners),
      namespaces: Object.fromEntries(this.namespaces),
    };
    try {
      atomicWrite(this.filePath, data);
    } catch {
      // Best-effort: disk errors must not crash the CP.
    }
  }

  put(descriptor: WorkspaceDescriptor, userId: string, namespace: string): void {
    this.workspaces.set(descriptor.id, descriptor);
    this.owners.set(descriptor.id, userId);
    this.namespaces.set(descriptor.id, namespace);
    this.saveToDisk();
  }

  get(id: string, userId?: string): WorkspaceDescriptor | undefined {
    if (userId !== undefined && this.owners.get(id) !== userId) return undefined;
    return this.workspaces.get(id);
  }

  has(id: string, userId: string): boolean {
    return (
      this.workspaces.has(id) && this.owners.get(id) === userId
    );
  }

  list(userId?: string): WorkspaceDescriptor[] {
    const all = [...this.workspaces.values()];
    if (userId === undefined) return all;
    return all.filter((w) => this.owners.get(w.id) === userId);
  }

  keys(): IterableIterator<string> {
    return this.workspaces.keys();
  }

  delete(id: string, userId: string): boolean {
    if (this.owners.get(id) !== userId) return false;
    this.owners.delete(id);
    this.namespaces.delete(id);
    const deleted = this.workspaces.delete(id);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  getNamespace(id: string): string | undefined {
    return this.namespaces.get(id);
  }
}
