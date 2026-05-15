import { spawn } from "node:child_process";

import type { ProcessHandle, Spawner } from "./agent.js";

export const childProcessSpawner: Spawner = (options) => {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => options.onStdout(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => options.onStderr(chunk));

  const exited = new Promise<{ exitCode: number | null; signal?: string }>(
    (resolve) => {
      child.once("exit", (code, signal) => {
        resolve({
          exitCode: code,
          ...(signal ? { signal } : {}),
        });
      });
    },
  );

  const handle: ProcessHandle = {
    write(data) {
      child.stdin?.write(data);
    },
    kill(signal) {
      child.kill(signal as NodeJS.Signals | undefined);
    },
    exited,
  };

  return handle;
};
