import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  SessionAgent,
  type AgentTransport,
  type IncomingEnvelope,
  type ProcessHandle,
  type Spawner,
} from "./agent.js";

function stubTransport(): {
  transport: AgentTransport;
  sent: RemoteEventEnvelope[];
  emit: (envelope: IncomingEnvelope) => void;
  closeResolve: () => void;
} {
  const sent: RemoteEventEnvelope[] = [];
  const handlers: Array<(envelope: IncomingEnvelope) => void> = [];
  let closeResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const transport: AgentTransport = {
    send(envelope) {
      sent.push(envelope);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    async close() {
      closeResolve();
      await closed;
    },
    closed,
  };
  return {
    transport,
    sent,
    emit: (envelope) => {
      for (const handler of handlers) handler(envelope);
    },
    closeResolve,
  };
}

type StubProcess = ProcessHandle & {
  readonly writes: string[];
  finish(result: { exitCode: number | null; signal?: string }): void;
};

function stubProcess(): StubProcess {
  const writes: string[] = [];
  let resolveExit!: (result: {
    exitCode: number | null;
    signal?: string;
  }) => void;
  const exited = new Promise<{ exitCode: number | null; signal?: string }>(
    (resolve) => {
      resolveExit = resolve;
    },
  );
  return {
    writes,
    write(data) {
      writes.push(data);
    },
    kill() {},
    exited,
    finish(result) {
      resolveExit(result);
    },
  };
}

function stubSpawner(
  handle: StubProcess,
  onCall?: (
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ) => void,
): Spawner {
  return (options) => {
    onCall?.(options.onStdout, options.onStderr);
    return handle;
  };
}

describe("SessionAgent", () => {
  it("emits terminal.opened then forwards stdout and exit as protocol events", async () => {
    const { transport, sent } = stubTransport();
    const proc = stubProcess();
    let stdout: (chunk: string) => void = () => {};
    const agent = new SessionAgent({
      sessionId: "sess-xyz",
      profile: "codex",
      workspacePath: "/workspace",
      transport,
      spawner: stubSpawner(proc, (out) => {
        stdout = out;
      }),
      clock: () => new Date("2026-05-14T19:00:00.000Z"),
    });

    agent.start();
    stdout("hello\n");
    proc.finish({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const types = sent.map((envelope) => envelope.type);
    expect(types).toEqual([
      "terminal.opened",
      "terminal.output",
      "terminal.exited",
    ]);

    const opened = sent[0]!;
    expect(opened.sessionId).toBe("sess-xyz");
    expect(opened.actor.kind).toBe("session-agent");

    const output = sent[1]!;
    expect(output.payload).toMatchObject({
      stream: "stdout",
      data: "hello\n",
      encoding: "utf8",
    });

    const exited = sent[2]!;
    expect(exited.payload.exitCode).toBe(0);
  });

  it("writes terminal.input data to the child process stdin", async () => {
    const { transport, emit } = stubTransport();
    const proc = stubProcess();
    const agent = new SessionAgent({
      sessionId: "sess-input",
      profile: "shell",
      workspacePath: "/workspace",
      transport,
      spawner: stubSpawner(proc),
    });
    agent.start();

    emit({
      type: "terminal.input",
      sessionId: "sess-input",
      payload: { terminalId: "ignored", data: "ls\n", encoding: "utf8" },
    });
    emit({
      type: "terminal.input",
      sessionId: "other-session",
      payload: { data: "should-skip" },
    });

    expect(proc.writes).toEqual(["ls\n"]);
  });

  it("propagates the signal field on abnormal exit", async () => {
    const { transport, sent } = stubTransport();
    const proc = stubProcess();
    const agent = new SessionAgent({
      sessionId: "sess-sig",
      profile: "shell",
      workspacePath: "/workspace",
      transport,
      spawner: stubSpawner(proc),
    });
    agent.start();
    proc.finish({ exitCode: null, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const exited = sent.find((envelope) => envelope.type === "terminal.exited");
    expect(exited).toBeDefined();
    expect(exited!.payload.signal).toBe("SIGTERM");
    expect(exited!.payload.exitCode).toBe(-1);
  });

  it("wraps an interactive CLI in a persistent login shell with startup args", async () => {
    const { transport, sent } = stubTransport();
    const proc = stubProcess();
    let command: string | null = null;
    let args: ReadonlyArray<string> | null = null;
    const agent = new SessionAgent({
      sessionId: "sess-startup",
      profile: "codex",
      workspacePath: "/workspace",
      transport,
      spawner: (options) => {
        command = options.command;
        args = options.args;
        return proc;
      },
      env: { SESSION_STARTUP_ARGS: JSON.stringify(["config", "install"]) },
    });
    agent.start();
    proc.finish({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Persistent-box: spawned as `/bin/bash -lc <wrapper> remote-session codex config install`.
    expect(command).toBe("/bin/bash");
    expect(args![0]).toBe("-lc");
    expect(args!.slice(2)).toEqual(["remote-session", "codex", "config", "install"]);
    expect(sent[0]!.payload.shell).toBe("/bin/bash");
  });

  it("does NOT wrap the shell profile (ephemeral push/pull one-shot)", async () => {
    const { transport } = stubTransport();
    const proc = stubProcess();
    let command: string | null = null;
    let args: ReadonlyArray<string> | null = null;
    const agent = new SessionAgent({
      sessionId: "sess-push",
      profile: "shell",
      workspacePath: "/workspace",
      transport,
      spawner: (options) => {
        command = options.command;
        args = options.args;
        return proc;
      },
      env: { SESSION_STARTUP_ARGS: JSON.stringify(["-c", "exit 0"]) },
    });
    agent.start();
    proc.finish({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(command).toBe("/bin/bash");
    expect(args).toEqual(["-c", "exit 0"]);
  });
});
