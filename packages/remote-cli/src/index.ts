#!/usr/bin/env node
import { Command } from "commander";

import { run } from "./run.js";

export const packageName = "@sentropic/remote-cli";

export { run } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";
export {
  resolveProfile,
  isCliProfile,
  withResume,
  type ProfileConfig,
} from "./profiles.js";

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const program = new Command();
  program
    .name("remote")
    .description(
      "Wrap a local agent CLI (codex/claude/gemini) and expose its session for remote attach.",
    )
    .version("0.0.0");

  for (const [profileName, alias] of [
    ["codex", undefined],
    ["claude-code", "claude"],
    ["gemini-cli", "gemini"],
    ["opencode", undefined],
    ["shell", undefined],
  ] as const) {
    const cmd = program
      .command(profileName)
      .description(`Run ${profileName} via remote-cli`)
      .option("-r, --resume <id>", "resume an existing session id")
      .option(
        "-p, --port <port>",
        "expose the in-process control-plane on this port",
        (value) => Number(value),
      )
      .action(async (opts: { resume?: string; port?: number }) => {
        const runOptions: import("./run.js").RunOptions = {
          profile: profileName,
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.port !== undefined ? { port: opts.port } : {}),
        };
        const result = await run(runOptions);
        process.stderr.write(
          `[remote] session ${result.sessionId} attach at http://127.0.0.1:${result.port}\n`,
        );
        const { exitCode } = await result.exit;
        process.exitCode = exitCode;
      });
    if (alias) cmd.alias(alias);
  }

  await program.parseAsync([...argv]);
  const code = process.exitCode;
  return typeof code === "number" ? code : 0;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("remote-cli/dist/index.js")) {
  main(process.argv).catch((error: unknown) => {
    console.error("[remote] fatal:", error);
    process.exitCode = 1;
  });
}
