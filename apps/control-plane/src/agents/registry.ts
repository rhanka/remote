import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";

export interface AgentConnection {
  send(envelope: RemoteEventEnvelope): void;
  close(code?: number, reason?: string): void;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentConnection>();

  register(sessionId: string, connection: AgentConnection): void {
    const existing = this.agents.get(sessionId);
    if (existing) {
      existing.close(1000, "replaced");
    }
    this.agents.set(sessionId, connection);
  }

  unregister(sessionId: string, connection?: AgentConnection): void {
    const current = this.agents.get(sessionId);
    if (!current) return;
    if (connection !== undefined && current !== connection) return;
    this.agents.delete(sessionId);
  }

  get(sessionId: string): AgentConnection | undefined {
    return this.agents.get(sessionId);
  }

  send(sessionId: string, envelope: RemoteEventEnvelope): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent) return false;
    agent.send(envelope);
    return true;
  }

  size(): number {
    return this.agents.size;
  }
}
