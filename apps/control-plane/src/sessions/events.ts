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

const DEFAULT_REPLAY_CAPACITY = 128;

function randomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

export type SessionEventBusOptions = {
  /** Last-N envelopes kept per session so late subscribers can backfill. */
  readonly replayCapacity?: number;
};

export class SessionEventBus {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private readonly sequences = new Map<string, number>();
  private readonly history = new Map<string, RemoteEventEnvelope[]>();
  private readonly replayCapacity: number;

  constructor(options: SessionEventBusOptions = {}) {
    this.replayCapacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
  }

  /**
   * Subscribe to a session's event stream. When `replay` is true (default),
   * the subscriber receives the buffered backlog of envelopes for the
   * session synchronously before any future event.
   */
  subscribe(
    sessionId: string,
    subscriber: EventSubscriber,
    options: { replay?: boolean } = {},
  ): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(subscriber);

    if (options.replay !== false) {
      const past = this.history.get(sessionId);
      if (past) {
        for (const envelope of past) subscriber(envelope);
      }
    }

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

    if (this.replayCapacity > 0) {
      let buffer = this.history.get(sessionId);
      if (!buffer) {
        buffer = [];
        this.history.set(sessionId, buffer);
      }
      buffer.push(envelope);
      if (buffer.length > this.replayCapacity) {
        buffer.splice(0, buffer.length - this.replayCapacity);
      }
    }

    const set = this.subscribers.get(sessionId);
    if (set) {
      for (const subscriber of set) subscriber(envelope);
    }

    return envelope;
  }

  /** Drop all buffered events for a session (used when a session is stopped). */
  forget(sessionId: string): void {
    this.history.delete(sessionId);
    this.sequences.delete(sessionId);
  }
}
