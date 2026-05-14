import {
  EVENT_TYPES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
  type Actor,
  type RemoteEventEnvelope,
} from "@sentropic/remote-protocol";

type EventType = (typeof EVENT_TYPES)[number];

export type EventSubscriber = (envelope: RemoteEventEnvelope) => void;

const controlPlaneActor: Actor = {
  id: "control-plane",
  kind: "control-plane",
  displayName: "Control Plane",
};

function randomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

export class SessionEventBus {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private readonly sequences = new Map<string, number>();

  subscribe(sessionId: string, subscriber: EventSubscriber): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(subscriber);

    return () => {
      set?.delete(subscriber);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  publish(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
    options?: { actor?: Actor; correlationId?: string },
  ): RemoteEventEnvelope {
    const previousSequence = this.sequences.get(sessionId) ?? -1;
    const sequence = previousSequence + 1;
    this.sequences.set(sessionId, sequence);

    const envelope: RemoteEventEnvelope = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: randomId("evt"),
      sessionId,
      sequence,
      type,
      occurredAt: new Date().toISOString(),
      correlationId: options?.correlationId ?? randomId("corr"),
      actor: options?.actor ?? controlPlaneActor,
      payload,
    };

    const set = this.subscribers.get(sessionId);
    if (set) {
      for (const subscriber of set) subscriber(envelope);
    }

    return envelope;
  }
}
