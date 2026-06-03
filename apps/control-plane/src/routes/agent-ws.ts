import {
  AGENT_MESSAGE_TYPES,
  type RemoteEventEnvelope,
  type SessionAnnounce,
} from "@sentropic/remote-protocol";
import type { WSContext, WSEvents } from "hono/ws";

import type { AgentRegistry, AgentConnection } from "../agents/registry.js";
import type { ReconcileFromAnnounce } from "./sessions.js";
import type { SessionEventBus } from "../sessions/events.js";
import type { SessionStore } from "../sessions/store.js";

export type AgentSocketDeps = {
  readonly store: SessionStore;
  readonly bus: SessionEventBus;
  readonly registry: AgentRegistry;
  /** Repopulate the store from an announce for an unknown session. */
  readonly reconcileFromAnnounce: ReconcileFromAnnounce;
  /** Validate an announce body against `sessionAnnounceSchema`. */
  readonly validateAnnounce: (body: unknown) => body is SessionAnnounce;
  /** Owner derived from the WS upgrade auth context (off-mode → "default"). */
  readonly userId: string;
};

/** The agent's first frame on (re)connect: `{ type, body: SessionAnnounce }`.
 * This is NOT a RemoteEventEnvelope — it carries no sequence/eventId, only the
 * announce type + body. */
type AnnounceFrame = { type: string; body: unknown };

// How long an unknown session's socket may stay open without a valid announce
// before we close it. Bounds an unauthenticated/idle socket without racing the
// agent's first frame (which is sent immediately on open).
const ANNOUNCE_GRACE_MS = 5_000;

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

function readText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(data));
  if (typeof Buffer !== "undefined" && data instanceof Uint8Array)
    return new TextDecoder().decode(data);
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isAnnounceFrame(value: unknown): value is AnnounceFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (AGENT_MESSAGE_TYPES as readonly string[]).includes(
      (value as { type?: unknown }).type as string,
    ) &&
    "body" in value
  );
}

function asEnvelope(value: unknown): RemoteEventEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as RemoteEventEnvelope;
}

export function buildAgentSocketEvents(
  sessionId: string,
  deps: AgentSocketDeps,
): WSEvents {
  let connection: AgentConnection | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function register(ws: WSContext): void {
    if (connection) return;
    clearGrace();
    connection = wsConnection(ws);
    deps.registry.register(sessionId, connection);
  }

  function teardown(): void {
    clearGrace();
    if (connection) {
      deps.registry.unregister(sessionId, connection);
      connection = null;
    }
  }

  return {
    onOpen(_event, ws) {
      // Known session (steady state, or never restarted): wire immediately.
      if (deps.store.get(sessionId)) {
        register(ws);
        return;
      }
      // Unknown session: do NOT reject. After a control-plane restart the store
      // is empty; the agent's first `session.announce` frame is the
      // authoritative establish. Keep the socket open briefly, awaiting it.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!connection) ws.close(1008, "session.not_found");
      }, ANNOUNCE_GRACE_MS);
    },
    onMessage(event, ws) {
      const text = readText(event.data);
      if (text === undefined) return;
      const parsed = parseJson(text);
      if (parsed === undefined) return;

      if (isAnnounceFrame(parsed)) {
        if (!deps.validateAnnounce(parsed.body)) {
          // Malformed announce: never crash. If the session is still unknown,
          // close cleanly; otherwise ignore (the session is already live).
          if (!deps.store.get(sessionId)) {
            clearGrace();
            ws.close(1008, "announce.invalid");
          }
          return;
        }
        const announce = parsed.body;
        // Reject a frame whose body addresses a different session than the URL.
        if (announce.sessionId !== sessionId) return;
        // Idempotent: a known session is left untouched; unknown is repopulated.
        deps.reconcileFromAnnounce(sessionId, announce, {
          userId: deps.userId,
        });
        register(ws);
        return;
      }

      // Non-announce envelopes keep their republish behavior. Drop them while
      // the session is still unknown (announce must establish it first).
      const envelope = asEnvelope(parsed);
      if (!envelope) return;
      if (envelope.sessionId !== sessionId) return;
      if (!deps.store.get(sessionId)) return;
      deps.bus.publish(envelope.sessionId, envelope.type, envelope.payload, {
        actor: envelope.actor,
        correlationId: envelope.correlationId,
      });
    },
    onClose() {
      teardown();
    },
    onError() {
      teardown();
    },
  };
}
