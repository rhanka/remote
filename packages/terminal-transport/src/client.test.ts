import { describe, expect, it, vi } from "vitest";
import { TerminalTransportClient } from "./client.js";

// ---------------------------------------------------------------------------
// Minimal WebSocket stub
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

function makeWsStub() {
  const listeners: Record<string, Listener[]> = {};
  const stub = {
    binaryType: "arraybuffer" as BinaryType,
    sent: [] as Array<string | ArrayBuffer | Uint8Array>,
    closed: false,
    closeCode: 0,
    closeReason: "",
    addEventListener(type: string, listener: Listener) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type]!.push(listener);
    },
    send(data: string | ArrayBuffer | Uint8Array) {
      this.sent.push(data);
    },
    close(code: number, reason: string) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
    },
    // Test helper: simulate incoming events
    emit(type: string, event: unknown) {
      for (const l of listeners[type] ?? []) l(event);
    },
  };
  return stub;
}

type WsStub = ReturnType<typeof makeWsStub>;

function makeConstructor(stub: WsStub) {
  return function WsConstructor(
    _url: string,
    _protocols: string | string[],
    _options: Record<string, unknown>,
  ): WsStub {
    return stub;
  } as unknown as new (
    url: string,
    protocols?: string | string[],
    options?: Record<string, unknown>,
  ) => WebSocket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalTransportClient", () => {
  it("resolves connect() when the WS fires open", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s1/terminal",
      "tok",
    );
    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;
    expect(stub.binaryType).toBe("arraybuffer");
  });

  it("sends binary data as a binary frame via write()", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s1/terminal",
      "tok",
    );
    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;

    const data = new Uint8Array([65, 66, 67]);
    client.write(data);
    expect(stub.sent).toHaveLength(1);
    // write() normalises to ArrayBuffer for WS.send() compatibility
    expect(stub.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(stub.sent[0] as ArrayBuffer)).toEqual(data);
  });

  it("sends a resize JSON text frame via resize()", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s2/terminal",
      "tok",
    );
    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;

    client.resize(120, 40);
    expect(stub.sent).toHaveLength(1);
    expect(typeof stub.sent[0]).toBe("string");
    const parsed = JSON.parse(stub.sent[0] as string) as unknown;
    expect(parsed).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("calls onData callbacks with Uint8Array from binary frames", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s3/terminal",
      "tok",
    );
    const received: Uint8Array[] = [];
    client.onData((d) => received.push(d));

    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;

    const buf = new ArrayBuffer(3);
    new Uint8Array(buf).set([1, 2, 3]);
    stub.emit("message", { data: buf });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("calls onClose callbacks when the WS closes", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s4/terminal",
      "tok",
    );
    const closeCalled = vi.fn();
    client.onClose(closeCalled);

    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;

    stub.emit("close", {});
    expect(closeCalled).toHaveBeenCalledOnce();
  });

  it("close() sends WS close with code 1000", async () => {
    const stub = makeWsStub();
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s5/terminal",
      "tok",
    );
    const connectPromise = client.connect(makeConstructor(stub));
    stub.emit("open", {});
    await connectPromise;

    client.close();
    expect(stub.closed).toBe(true);
    expect(stub.closeCode).toBe(1000);
    expect(stub.closeReason).toBe("client.close");
  });

  it("throws when write() is called before connect()", () => {
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s6/terminal",
      "tok",
    );
    expect(() => client.write(new Uint8Array([1]))).toThrow("Not connected");
  });

  it("throws when resize() is called before connect()", () => {
    const client = new TerminalTransportClient(
      "wss://cp/sessions/s6/terminal",
      "tok",
    );
    expect(() => client.resize(80, 24)).toThrow("Not connected");
  });
});
