import type { SessionDescriptor } from "@sentropic/remote-protocol";

/**
 * In-memory session registry, partitioned by owner (the authenticated
 * `userId`). When a `userId` is supplied the store enforces ownership:
 * `get`/`delete` of another user's session resolve to `undefined`/`false`, and
 * `list` returns only that user's sessions. Omitting `userId` performs an
 * unscoped (system) lookup — used by internal callers such as the agent
 * WebSocket that authenticate the session, not a user.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionDescriptor>();
  private readonly owners = new Map<string, string>();

  put(descriptor: SessionDescriptor, userId?: string): SessionDescriptor {
    this.sessions.set(descriptor.id, descriptor);
    if (userId !== undefined) this.owners.set(descriptor.id, userId);
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

  delete(id: string, userId?: string): boolean {
    if (userId !== undefined && this.owners.get(id) !== userId) return false;
    this.owners.delete(id);
    return this.sessions.delete(id);
  }
}
