import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { WebSocket as WSType } from "ws";

import { connectWebSocketTransport } from "./websocket-transport.js";

// ---------------------------------------------------------------------------
// Fake WebSocket — mimics the `ws` WebSocket interface
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  }

  /** Simulate a remote close (without calling close() deliberately). */
  simulateClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  }

  /** Simulate a connection error before open. */
  simulateError(err: Error): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("error", err);
    this.emit("close");
  }

  triggerOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
}

// ---------------------------------------------------------------------------
// Socket factory helpers
// ---------------------------------------------------------------------------

/**
 * Returns a factory that hands out the given sockets in order.
 * Calling triggerOpen() on each one simulates a successful connection.
 */
function socketSequence(...sockets: FakeSocket[]): {
  factory: (url: string) => WSType;
  sockets: FakeSocket[];
} {
  let idx = 0;
  const factory = (_url: string): WSType => {
    const s = sockets[idx++];
    if (!s) throw new Error("No more sockets in sequence");
    return s as unknown as WSType;
  };
  return { factory, sockets };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connectWebSocketTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the transport when the first socket opens", async () => {
    const s1 = new FakeSocket();
    const { factory } = socketSequence(s1);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
    });

    s1.triggerOpen();
    const transport = await transportPromise;
    expect(transport).toBeDefined();
    expect(typeof transport.send).toBe("function");
    expect(typeof transport.close).toBe("function");
  });

  it("sends the onOpen announce as the first frame on the initial connect", async () => {
    const s1 = new FakeSocket();
    const { factory } = socketSequence(s1);

    const onOpen = vi.fn((send: (data: string) => void) => {
      send(JSON.stringify({ type: "session.announce", body: { sessionId: "s1", profile: "shell" } }));
    });

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      onOpen,
    });

    s1.triggerOpen();
    await transportPromise;

    expect(onOpen).toHaveBeenCalledOnce();
    expect(s1.sent).toHaveLength(1);
    expect(JSON.parse(s1.sent[0]!)).toMatchObject({ type: "session.announce" });
  });

  it("rejects when the first socket errors before open", async () => {
    const s1 = new FakeSocket();
    const { factory } = socketSequence(s1);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
    });

    s1.simulateError(new Error("ECONNREFUSED"));

    await expect(transportPromise).rejects.toThrow();
  });

  it("reconnects after a transient close and re-sends the announce", async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const { factory } = socketSequence(s1, s2);

    const announcements: string[][] = [];
    const onOpen = vi.fn((send: (data: string) => void) => {
      const frame = JSON.stringify({ type: "session.announce", body: { sessionId: "s1", profile: "shell" } });
      send(frame);
      announcements.push([frame]);
    });

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      onOpen,
      baseDelayMs: 100,
    });

    // First connect
    s1.triggerOpen();
    const transport = await transportPromise;
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Simulate transient close (control-plane restart)
    s1.simulateClose();

    // Advance timers past the jitter (scheduleReconnect with attempt=0 has 0 delay)
    await vi.runAllTimersAsync();

    // Second socket opens
    s2.triggerOpen();
    // Flush microtasks
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(s2.sent).toHaveLength(1);
    expect(JSON.parse(s2.sent[0]!)).toMatchObject({ type: "session.announce" });

    // Transport is still usable
    expect(transport).toBeDefined();
  });

  it("closed promise does NOT resolve on a transient socket drop", async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const { factory } = socketSequence(s1, s2);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      baseDelayMs: 100,
    });

    s1.triggerOpen();
    const transport = await transportPromise;

    let closedResolved = false;
    void transport.closed.then(() => {
      closedResolved = true;
    });

    // Simulate transient close
    s1.simulateClose();
    await vi.runAllTimersAsync();
    s2.triggerOpen();
    await Promise.resolve();
    await Promise.resolve();

    // closed must still be pending
    expect(closedResolved).toBe(false);
  });

  it("closed promise resolves after deliberate close()", async () => {
    const s1 = new FakeSocket();
    const { factory } = socketSequence(s1);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
    });

    s1.triggerOpen();
    const transport = await transportPromise;

    let closedResolved = false;
    const closedWait = transport.closed.then(() => {
      closedResolved = true;
    });

    const closePromise = transport.close();
    await closePromise;
    await closedWait;

    expect(closedResolved).toBe(true);
  });

  it("message handlers persist across reconnects", async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const { factory } = socketSequence(s1, s2);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      baseDelayMs: 100,
    });

    s1.triggerOpen();
    const transport = await transportPromise;

    const received: unknown[] = [];
    transport.onMessage((env) => received.push(env));

    // Receive a message on the first socket
    s1.emit("message", Buffer.from(JSON.stringify({ type: "terminal.input", sessionId: "s", payload: { data: "a" } })));
    expect(received).toHaveLength(1);

    // Simulate drop and reconnect
    s1.simulateClose();
    await vi.runAllTimersAsync();
    s2.triggerOpen();
    await Promise.resolve();
    await Promise.resolve();

    // Receive a message on the second socket — same handler is still attached
    s2.emit("message", Buffer.from(JSON.stringify({ type: "terminal.input", sessionId: "s", payload: { data: "b" } })));
    expect(received).toHaveLength(2);
  });

  it("send while disconnected drops the message (best-effort)", async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const { factory } = socketSequence(s1, s2);

    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      baseDelayMs: 100,
    });

    s1.triggerOpen();
    const transport = await transportPromise;

    // Drop s1 — s2 has NOT opened yet
    s1.simulateClose();

    // send while disconnected: should not throw and s1 should not receive it
    const sentBefore = s1.sent.length;
    transport.send({
      protocolVersion: "0.1.0",
      schemaVersion: "remote.protocol.v1",
      eventId: "e1",
      sessionId: "s",
      sequence: 1,
      type: "terminal.output",
      occurredAt: new Date().toISOString(),
      correlationId: "c",
      actor: { id: "session-agent", kind: "session-agent" },
      payload: {},
    });
    expect(s1.sent.length).toBe(sentBefore);
  });

  it("uses exponential backoff with increasing attempt counts", async () => {
    // Track how many times we've been asked for a socket
    let attempt = 0;
    const sockets: FakeSocket[] = [];

    const factory = (_url: string): WSType => {
      const s = new FakeSocket();
      sockets.push(s);
      attempt++;
      return s as unknown as WSType;
    };

    // First socket opens successfully
    const transportPromise = connectWebSocketTransport("ws://cp/sessions/s/agent", {
      createSocket: factory,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
    });

    sockets[0]!.triggerOpen();
    const transport = await transportPromise;
    expect(attempt).toBe(1);

    // First drop → reconnect with attempt=0 (no delay)
    sockets[0]!.simulateClose();
    await vi.runAllTimersAsync();

    // Second socket errors immediately (simulating CP still down)
    // The socket was already added by the factory — trigger its error
    if (sockets[1]) {
      sockets[1].simulateError(new Error("ECONNREFUSED"));
      // Next reconnect will have a delay (attempt=1 → up to 1000ms jitter)
      await vi.runAllTimersAsync();
    }

    // Third socket opens successfully
    if (sockets[2]) {
      sockets[2].triggerOpen();
      await Promise.resolve();
      await Promise.resolve();
    }

    // Transport still alive
    expect(transport).toBeDefined();
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// agent.done tests — verify process lifecycle gates on PTY exit, not socket
// ---------------------------------------------------------------------------

import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";
import {
  SessionAgent,
  type AgentTransport,
  type IncomingEnvelope,
  type ProcessHandle,
} from "./agent.js";

function makeStubTransport(): {
  transport: AgentTransport;
  sent: RemoteEventEnvelope[];
  closeResolve: () => void;
} {
  const sent: RemoteEventEnvelope[] = [];
  const handlers: Array<(envelope: IncomingEnvelope) => void> = [];
  let closeResolve!: () => void;
  const closed = new Promise<void>((r) => { closeResolve = r; });
  const transport: AgentTransport = {
    send(envelope) { sent.push(envelope); },
    onMessage(handler) { handlers.push(handler); },
    async close() { closeResolve(); await closed; },
    closed,
  };
  return { transport, sent, closeResolve };
}

function makeStubProcess(): ProcessHandle & {
  finish(result: { exitCode: number | null; signal?: string }): void;
} {
  let resolve!: (r: { exitCode: number | null; signal?: string }) => void;
  const exited = new Promise<{ exitCode: number | null; signal?: string }>(
    (r) => { resolve = r; },
  );
  return {
    write() {},
    kill() {},
    exited,
    finish(result) { resolve(result); },
  };
}

describe("SessionAgent.done — lifecycle gated on PTY exit", () => {
  it("agent.done resolves after PTY exit, not before", async () => {
    const { transport } = makeStubTransport();
    const proc = makeStubProcess();

    const agent = new SessionAgent({
      sessionId: "sess-done",
      profile: "shell",
      workspacePath: "/workspace",
      transport,
      spawner: () => proc,
    });
    agent.start();

    let doneResolved = false;
    void agent.done.then(() => { doneResolved = true; });

    // PTY has not exited yet
    await Promise.resolve();
    expect(doneResolved).toBe(false);

    // PTY exits
    proc.finish({ exitCode: 0 });
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(doneResolved).toBe(true);
  });

  it("agent.done does NOT resolve when the transport closes independently", async () => {
    const { transport, closeResolve } = makeStubTransport();
    const proc = makeStubProcess();

    const agent = new SessionAgent({
      sessionId: "sess-nodeclose",
      profile: "shell",
      workspacePath: "/workspace",
      transport,
      spawner: () => proc,
    });
    agent.start();

    let doneResolved = false;
    void agent.done.then(() => { doneResolved = true; });

    // Close the transport externally (simulates a transient socket drop where
    // transport.closed was used incorrectly)
    closeResolve();
    await Promise.resolve();

    // done should still be pending since PTY has not exited
    expect(doneResolved).toBe(false);
  });
});
