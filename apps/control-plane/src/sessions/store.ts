import type { SessionDescriptor } from "@remote-controle/protocol";

export class SessionStore {
  private readonly sessions = new Map<string, SessionDescriptor>();

  put(descriptor: SessionDescriptor): SessionDescriptor {
    this.sessions.set(descriptor.id, descriptor);
    return descriptor;
  }

  get(id: string): SessionDescriptor | undefined {
    return this.sessions.get(id);
  }

  list(): SessionDescriptor[] {
    return [...this.sessions.values()];
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }
}
