import {
  EVENT_TYPES,
  type SessionDescriptor,
} from "@sentropic/remote-protocol";

export const packageName = "@sentropic/remote-k8s-orchestrator";

type EventType = (typeof EVENT_TYPES)[number];

export type ProvisionerEmit = (
  sessionId: string,
  type: EventType,
  payload: Record<string, unknown>,
) => void;

export interface SessionProvisioner {
  provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
  ): Promise<void>;
  destroy(sessionId: string, emit: ProvisionerEmit): Promise<void>;
  inspect(sessionId: string): Promise<{ phase: string } | undefined>;
}

const LIFECYCLE_TRANSITIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "requested", to: "provisioning" },
  { from: "provisioning", to: "starting" },
  { from: "starting", to: "ready" },
];

export class InMemoryProvisioner implements SessionProvisioner {
  private readonly phases = new Map<string, string>();

  async provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
  ): Promise<void> {
    for (const transition of LIFECYCLE_TRANSITIONS) {
      this.phases.set(descriptor.id, transition.to);
      emit(descriptor.id, "session.lifecycle.changed", {
        previousState: transition.from,
        nextState: transition.to,
      });
    }
  }

  async destroy(sessionId: string, emit: ProvisionerEmit): Promise<void> {
    const previous = this.phases.get(sessionId) ?? "running";
    this.phases.set(sessionId, "stopping");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: previous,
      nextState: "stopping",
    });
    this.phases.set(sessionId, "stopped");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: "stopping",
      nextState: "stopped",
    });
    this.phases.delete(sessionId);
  }

  async inspect(sessionId: string): Promise<{ phase: string } | undefined> {
    const phase = this.phases.get(sessionId);
    return phase ? { phase } : undefined;
  }
}
