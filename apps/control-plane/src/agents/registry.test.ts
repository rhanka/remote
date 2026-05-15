import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import { AgentRegistry, type AgentConnection } from "./registry.js";

function recordingConnection(): {
  connection: AgentConnection;
  sent: RemoteEventEnvelope[];
  closed: Array<{ code?: number; reason?: string }>;
} {
  const sent: RemoteEventEnvelope[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    connection: {
      send(envelope) {
        sent.push(envelope);
      },
      close(code, reason) {
        const entry: { code?: number; reason?: string } = {};
        if (code !== undefined) entry.code = code;
        if (reason !== undefined) entry.reason = reason;
        closed.push(entry);
      },
    },
  };
}

const envelope = (sessionId: string): RemoteEventEnvelope => ({
  protocolVersion: "0.1.0",
  schemaVersion: "remote.protocol.v1",
  eventId: "evt-1",
  sessionId,
  sequence: 0,
  type: "terminal.input",
  occurredAt: "2026-05-14T20:00:00.000Z",
  correlationId: "corr-1",
  actor: {
    id: "control-plane",
    kind: "control-plane",
    displayName: "Control Plane",
  },
  payload: { terminalId: "t", data: "x", encoding: "utf8" },
});

describe("AgentRegistry", () => {
  it("delivers messages to the registered agent and counts size", () => {
    const registry = new AgentRegistry();
    const a = recordingConnection();
    registry.register("sess-1", a.connection);
    expect(registry.size()).toBe(1);

    expect(registry.send("sess-1", envelope("sess-1"))).toBe(true);
    expect(a.sent).toHaveLength(1);

    expect(registry.send("sess-other", envelope("sess-other"))).toBe(false);
  });

  it("closes the previous connection when a new one registers for the same session", () => {
    const registry = new AgentRegistry();
    const first = recordingConnection();
    const second = recordingConnection();
    registry.register("sess-1", first.connection);
    registry.register("sess-1", second.connection);
    expect(first.closed).toHaveLength(1);
    expect(registry.size()).toBe(1);

    registry.send("sess-1", envelope("sess-1"));
    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
  });

  it("unregister only removes the matching connection", () => {
    const registry = new AgentRegistry();
    const first = recordingConnection();
    const second = recordingConnection();
    registry.register("sess-1", first.connection);

    registry.unregister("sess-1", second.connection);
    expect(registry.size()).toBe(1);

    registry.unregister("sess-1", first.connection);
    expect(registry.size()).toBe(0);
  });
});
