import { describe, expect, it } from "vitest";

import type { PtyHandle, PtySpawner } from "./pty.js";
import { run } from "./run.js";

type StubPty = PtyHandle & {
  readonly writes: string[];
  emitData(chunk: string): void;
  emitExit(exitCode: number, signal?: number): void;
};

function stubSpawner(): { spawner: PtySpawner; pty: StubPty } {
  let dataHandler: (chunk: string) => void = () => {};
  let exitHandler: (event: {
    exitCode: number;
    signal?: number;
  }) => void = () => {};
  const writes: string[] = [];
  const pty: StubPty = {
    cols: 80,
    rows: 24,
    write(data) {
      writes.push(data);
    },
    resize() {},
    kill() {},
    onData(handler) {
      dataHandler = handler;
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandler = handler;
      return { dispose() {} };
    },
    writes,
    emitData(chunk) {
      dataHandler(chunk);
    },
    emitExit(exitCode, signal) {
      const event: { exitCode: number; signal?: number } = { exitCode };
      if (signal !== undefined) event.signal = signal;
      exitHandler(event);
    },
  };
  return {
    pty,
    spawner: () => pty,
  };
}

function stubStdin(): NodeJS.ReadStream {
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
    emit(event: string, ...args: unknown[]) {
      if (event === "data") for (const l of listeners) l(args[0] as Buffer);
      return true;
    },
  } as unknown as NodeJS.ReadStream;
}

function stubStdout(): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  return {
    columns: 100,
    rows: 30,
    write(chunk: string | Buffer) {
      written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    on() {
      return this as unknown as NodeJS.WriteStream;
    },
    written,
  } as unknown as NodeJS.WriteStream & { written: string[] };
}

describe("run", () => {
  it("spawns the resolved profile, forwards stdout, and stops cleanly on PTY exit", async () => {
    const { spawner, pty } = stubSpawner();
    const stdin = stubStdin();
    const stdout = stubStdout();
    const result = await run({
      profile: "shell",
      port: 0,
      spawner,
      stdin,
      stdout,
      initialSize: { cols: 100, rows: 30 },
    });

    pty.emitData("hello\n");
    expect(result.port).toBeGreaterThan(0);
    pty.emitExit(0);
    const exit = await result.exit;
    expect(exit.exitCode).toBe(0);
    expect((stdout as { written: string[] }).written).toContain("hello\n");
  });

  it("leads the argv with the resume subcommand when resuming a codex session", async () => {
    let captured: { command: string; args: ReadonlyArray<string> } | null =
      null;
    const { pty } = stubSpawner();
    const spy: PtySpawner = (options) => {
      captured = { command: options.command, args: options.args };
      return pty;
    };
    const result = await run({
      profile: "codex",
      resume: "sess-abc",
      port: 0,
      spawner: spy,
      stdin: stubStdin(),
      stdout: stubStdout(),
      initialSize: { cols: 80, rows: 24 },
    });
    pty.emitExit(0);
    await result.exit;
    expect(captured).toEqual({
      command: "codex",
      args: ["resume", "sess-abc"],
    });
  });

  it("appends startup args to the resolved command", async () => {
    let captured: { command: string; args: ReadonlyArray<string> } | null = null;
    const { pty } = stubSpawner();
    const spy: PtySpawner = (options) => {
      captured = { command: options.command, args: options.args };
      return pty;
    };
    const result = await run({
      profile: "codex",
      startupArgs: ["config", "install"],
      port: 0,
      spawner: spy,
      stdin: stubStdin(),
      stdout: stubStdout(),
      initialSize: { cols: 80, rows: 24 },
    });
    pty.emitExit(0);
    await result.exit;
    expect(captured).toEqual({
      command: "codex",
      args: ["config", "install"],
    });
  });

  it("forwards stdin data into the PTY write stream", async () => {
    const { spawner, pty } = stubSpawner();
    const stdin = stubStdin();
    const stdout = stubStdout();
    const result = await run({
      profile: "shell",
      port: 0,
      spawner,
      stdin,
      stdout,
      initialSize: { cols: 80, rows: 24 },
    });

    (stdin as unknown as { emit: (event: string, data: Buffer) => void }).emit(
      "data",
      Buffer.from("ls\n", "utf8"),
    );

    expect(pty.writes).toContain("ls\n");
    pty.emitExit(0);
    await result.exit;
  });
});
