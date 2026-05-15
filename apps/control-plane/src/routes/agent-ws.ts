import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";
import type { WSContext, WSEvents } from "hono/ws";

import type { AgentRegistry, AgentConnection } from "../agents/registry.js";
import type { SessionEventBus } from "../sessions/events.js";
import type { SessionStore } from "../sessions/store.js";

export type AgentSocketDeps = {
  readonly store: SessionStore;
  readonly bus: SessionEventBus;
  readonly registry: AgentRegistry;
};

function wsConnection(ws: WSContext): AgentConnection {
  return {
    send(envelope: RemoteEventEnvelope) {
      ws.send(JSON.stringify(envelope));
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

function readMessage(data: unknown): RemoteEventEnvelope | undefined {
  let text: string | undefined;
  if (typeof data === "string") text = data;
  else if (data instanceof ArrayBuffer)
    text = new TextDecoder().decode(new Uint8Array(data));
  else if (typeof Buffer !== "undefined" && data instanceof Uint8Array) {
    text = new TextDecoder().decode(data);
  } else return undefined;

  try {
    return JSON.parse(text) as RemoteEventEnvelope;
  } catch {
    return undefined;
  }
}

export function buildAgentSocketEvents(
  sessionId: string,
  deps: AgentSocketDeps,
): WSEvents {
  let connection: AgentConnection | null = null;

  return {
    onOpen(_event, ws) {
      if (!deps.store.get(sessionId)) {
        ws.close(1008, "session.not_found");
        return;
      }
      connection = wsConnection(ws);
      deps.registry.register(sessionId, connection);
    },
    onMessage(event) {
      const envelope = readMessage(event.data);
      if (!envelope) return;
      if (envelope.sessionId !== sessionId) return;
      deps.bus.publish(envelope.sessionId, envelope.type, envelope.payload, {
        actor: envelope.actor,
        correlationId: envelope.correlationId,
      });
    },
    onClose() {
      if (connection) {
        deps.registry.unregister(sessionId, connection);
        connection = null;
      }
    },
    onError() {
      if (connection) {
        deps.registry.unregister(sessionId, connection);
        connection = null;
      }
    },
  };
}
