import { describe, expect, it } from "vitest";

import {
  attach,
  createRemoteSession,
  listRemoteSessions,
  stopRemoteSession,
} from "./attach.js";

type Captured = {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
};

function ssePayload(envelopes: Array<Record<string, unknown>>): string {
  return (
    envelopes
      .map(
        (envelope) =>
          `event: ${String(envelope.type)}\ndata: ${JSON.stringify(envelope)}`,
      )
      .join("\n\n") + "\n\n"
  );
}

function streamFromString(payload: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function stubStdin(): NodeJS.ReadStream & {
  emit: (event: string, data: Buffer) => void;
} {
  const listeners: Array<(data: Buffer) => void> = [];
  return {
    isTTY: false,
    setRawMode() {
      return this as unknown as NodeJS.ReadStream;
    },
    resume() {},
    pause() {},
    on(event: string, listener: (data: Buffer) => void) {
      if (event === "data") listeners.push(listener);
      return this as unknown as NodeJS.ReadStream;
    },
    off(event: string, listener: (data: Buffer) => void) {
      if (event === "data") {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }
      return this as unknown as NodeJS.ReadStream;
    },
    emit(event: string, ...args: unknown[]) {
      if (event === "data")
        for (const listener of listeners) listener(args[0] as Buffer);
      return true;
    },
  } as unknown as NodeJS.ReadStream & {
    emit: (event: string, data: Buffer) => void;
  };
}

function stubStdout(): NodeJS.WriteStream & {
  emit: (event: string) => void;
  written: string[];
} {
  const written: string[] = [];
  const resizeListeners: Array<() => void> = [];
  return {
    columns: 100,
    rows: 30,
    write(chunk: string | Buffer) {
      written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    on(event: string, listener: () => void) {
      if (event === "resize") resizeListeners.push(listener);
      return this as unknown as NodeJS.WriteStream;
    },
    off(event: string, listener: () => void) {
      if (event === "resize") {
        const index = resizeListeners.indexOf(listener);
        if (index >= 0) resizeListeners.splice(index, 1);
      }
      return this as unknown as NodeJS.WriteStream;
    },
    emit(event: string) {
      if (event === "resize")
        for (const listener of [...resizeListeners]) listener();
      return true;
    },
    written,
  } as unknown as NodeJS.WriteStream & {
    emit: (event: string) => void;
    written: string[];
  };
}

describe("attach", () => {
  it("renders SSE terminal.output to stdout and closes on terminal.exited", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      const body = ssePayload([
        {
          type: "terminal.output",
          payload: { data: "hello\n" },
        },
        {
          type: "terminal.exited",
          payload: { exitCode: 0 },
        },
      ]);
      return new Response(streamFromString(body), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-1",
      stdin,
      stdout,
      fetchImpl,
    });
    await session.finished;

    expect((stdout as { written: string[] }).written).toContain("hello\n");
    expect(calls[0]!.url).toBe("http://localhost:8080/sessions/sess-1/events");
  });

  it("closes on terminal.exited even when the SSE stream stays open", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchImpl = (async (url: string | URL) => {
      if (url.toString().endsWith("/events")) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-exit",
      stdin,
      stdout,
      fetchImpl,
    });
    streamController.enqueue(
      encoder.encode(
        ssePayload([
          {
            type: "terminal.exited",
            payload: { exitCode: 0 },
          },
        ]),
      ),
    );

    const finished = await Promise.race([
      session.finished.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    if (!finished) await session.close();

    expect(finished).toBe(true);
  });

  it("forwards stdin data through POST /terminal/input", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (url.toString().endsWith("/events")) {
        return new Response(streamFromString(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-input",
      stdin,
      stdout,
      fetchImpl,
    });

    stdin.emit("data", Buffer.from("ls\n", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.close();

    const input = calls.find((call) => call.url.endsWith("/terminal/input"));
    expect(input).toBeDefined();
    expect(input!.method).toBe("POST");
    const body = JSON.parse(input!.body as string) as { data: string };
    expect(body.data).toBe("ls\n");
  });

  it("forwards terminal resize through POST /terminal/resize", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (url.toString().endsWith("/events")) {
        return new Response(streamFromString(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-resize",
      stdin,
      stdout,
      fetchImpl,
    });

    stdout.columns = 132;
    stdout.rows = 50;
    stdout.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.close();

    const resize = calls.find((call) => call.url.endsWith("/terminal/resize"));
    expect(resize).toBeDefined();
    expect(resize!.method).toBe("POST");
    const body = JSON.parse(resize!.body as string) as {
      columns: number;
      rows: number;
    };
    expect(body).toMatchObject({
      terminalId: "operator",
      columns: 132,
      rows: 50,
    });
  });

  it("listRemoteSessions GETs /sessions and returns the array", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          sessions: [
            {
              id: "sess-1",
              profile: "codex",
              target: "k3s",
              createdAt: "now",
            },
            {
              id: "sess-2",
              profile: "claude-code",
              target: "k3s",
              createdAt: "now",
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const sessions = await listRemoteSessions(
      "http://localhost:8080",
      fetchImpl,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.id).toBe("sess-1");
  });

  it("stopRemoteSession POSTs the reason and returns accepted", async () => {
    let body: string | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = init?.body as string;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;
    const result = await stopRemoteSession(
      "http://localhost:8080",
      "sess-zzz",
      "uat",
      fetchImpl,
    );
    expect(result.accepted).toBe(true);
    const parsed = JSON.parse(body!) as { reason: string };
    expect(parsed.reason).toBe("uat");
  });

  it("retries POST /terminal/input on transient 5xx until it succeeds", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    let inputCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith("/events")) {
        return new Response(streamFromString(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (href.endsWith("/terminal/input")) {
        inputCalls++;
        if (inputCalls < 3) {
          return new Response("", { status: 502 });
        }
        return new Response('{"accepted":true}', { status: 202 });
      }
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-retry",
      stdin,
      stdout,
      fetchImpl,
      inputRetry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4 },
    });

    stdin.emit("data", Buffer.from("x", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.close();

    expect(inputCalls).toBe(3);
  });

  it("preserves keystroke order when an earlier POST is retried", async () => {
    const stdout = stubStdout();
    const stdin = stubStdin();
    const ordered: string[] = [];
    let firstAttempt = true;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.endsWith("/events")) {
        return new Response(streamFromString(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (href.endsWith("/terminal/input")) {
        const body = JSON.parse(init?.body as string) as { data: string };
        if (body.data === "A" && firstAttempt) {
          firstAttempt = false;
          return new Response("", { status: 502 });
        }
        ordered.push(body.data);
        return new Response('{"accepted":true}', { status: 202 });
      }
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const session = await attach({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-order",
      stdin,
      stdout,
      fetchImpl,
      inputRetry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4 },
    });

    stdin.emit("data", Buffer.from("A", "utf8"));
    stdin.emit("data", Buffer.from("B", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.close();

    expect(ordered).toEqual(["A", "B"]);
  });

  it("createRemoteSession posts profile + target and returns the new id", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = {
        url: url.toString(),
        body: init?.body as string,
      };
      return new Response(
        JSON.stringify({
          session: { id: "sess-remote" },
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    const result = await createRemoteSession(
      "http://localhost:8080",
      { profile: "codex" },
      fetchImpl,
    );
    expect(result.id).toBe("sess-remote");
    expect(captured!.url).toBe("http://localhost:8080/sessions");
    const body = JSON.parse(captured!.body) as { profile: string };
    expect(body.profile).toBe("codex");
  });
});
