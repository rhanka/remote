import type * as nodePty from "node-pty";

export type PtyHandle = {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (chunk: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
};

export type PtySpawner = (options: {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
}) => PtyHandle;

export const nodePtySpawner: PtySpawner = (options) => {
  // Lazy load node-pty so test environments without the native binary still
  // import this module — they substitute a stub spawner.

  const pty: typeof nodePty = require("node-pty");
  const proc = pty.spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
  });
  return {
    get cols() {
      return options.cols;
    },
    get rows() {
      return options.rows;
    },
    write(data) {
      proc.write(data);
    },
    resize(cols, rows) {
      proc.resize(cols, rows);
    },
    kill(signal) {
      proc.kill(signal);
    },
    onData(handler) {
      const subscription = proc.onData(handler);
      return { dispose: () => subscription.dispose() };
    },
    onExit(handler) {
      const subscription = proc.onExit((event) => {
        const payload: { exitCode: number; signal?: number } = {
          exitCode: event.exitCode,
        };
        if (event.signal !== undefined) payload.signal = event.signal;
        handler(payload);
      });
      return { dispose: () => subscription.dispose() };
    },
  };
};
