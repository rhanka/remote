import { createRequire } from "node:module";

import type { ProcessHandle, Spawner } from "./agent.js";

const require = createRequire(import.meta.url);

export const ptySpawner: Spawner = (options) => {
  // Lazy-require node-pty so unit tests can substitute a stub Spawner without
  // needing the native binary to be present.
  const pty: typeof import("node-pty") = require("node-pty");
  const proc = pty.spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    cols: 80,
    rows: 24,
    name: "xterm-256color",
  });

  proc.onData((chunk) => options.onStdout(chunk));

  const exited = new Promise<{ exitCode: number | null; signal?: string }>(
    (resolve) => {
      proc.onExit((event) => {
        const payload: { exitCode: number | null; signal?: string } = {
          exitCode: event.exitCode,
        };
        if (event.signal !== undefined) payload.signal = String(event.signal);
        resolve(payload);
      });
    },
  );

  const handle: ProcessHandle = {
    write(data) {
      proc.write(data);
    },
    resize(cols, rows) {
      proc.resize(cols, rows);
    },
    kill(signal) {
      proc.kill(signal);
    },
    exited,
  };
  return handle;
};
