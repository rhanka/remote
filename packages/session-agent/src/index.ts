import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { SessionAgent } from "./agent.js";
import { ptySpawner } from "./pty-spawner.js";
import { childProcessSpawner } from "./spawner.js";
import { connectWebSocketTransport } from "./websocket-transport.js";
import { exportWorkspace, materializeWorkspace } from "./workspace-sync.js";

export const packageName = "@sentropic/remote-session-agent";

export { materializeWorkspace, exportWorkspace } from "./workspace-sync.js";
export type {
  MaterializeWorkspaceOptions,
  ExportWorkspaceOptions,
} from "./workspace-sync.js";

export function materializeAuthBundle(
  stagingDir: string | undefined,
  relPathsCsv: string | undefined,
  home: string,
): ReadonlyArray<string> {
  if (!stagingDir || !relPathsCsv) return [];
  const relPaths = relPathsCsv.split(":").filter((p) => p.length > 0);
  const copied: string[] = [];
  for (const relPath of relPaths) {
    const src = join(stagingDir, relPath);
    const dst = join(home, relPath);
    try {
      statSync(src);
    } catch {
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    copied.push(relPath);
  }
  return copied;
}

export { SessionAgent } from "./agent.js";
export type {
  AgentTransport,
  IncomingEnvelope,
  ProcessHandle,
  SessionAgentOptions,
  Spawner,
  SpawnerOptions,
} from "./agent.js";
export { childProcessSpawner } from "./spawner.js";
export { ptySpawner } from "./pty-spawner.js";
export { connectWebSocketTransport } from "./websocket-transport.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function main(): Promise<void> {
  const sessionId = requireEnv("SESSION_ID");
  const profile = requireEnv("SESSION_PROFILE");
  const workspacePath = process.env.WORKSPACE_PATH ?? "/workspace";
  const controlPlaneEndpoint = requireEnv("CONTROL_PLANE_ENDPOINT");
  const home = process.env.HOME ?? "/root";

  const copied = materializeAuthBundle(
    process.env.SESSION_AUTH_STAGING_DIR,
    process.env.SESSION_AUTH_BUNDLE_PATHS,
    home,
  );
  if (copied.length > 0) {
    console.log(
      `[session-agent] materialized ${copied.length} auth file(s) under ${home}`,
    );
  }

  if (process.env.SESSION_WORKSPACE_SYNC === "1") {
    try {
      const extracted = await materializeWorkspace({
        controlPlaneEndpoint,
        sessionId,
        workspacePath,
      });
      console.log(
        extracted
          ? `[session-agent] extracted workspace archive into ${workspacePath}`
          : `[session-agent] no workspace archive staged; starting with an empty ${workspacePath}`,
      );
    } catch (error) {
      console.error("[session-agent] workspace sync failed:", error);
    }
  }

  if (process.env.SESSION_WORKSPACE_EXPORT === "1") {
    try {
      const bytes = await exportWorkspace({
        controlPlaneEndpoint,
        sessionId,
        workspacePath,
      });
      console.log(
        `[session-agent] exported ${workspacePath} (${bytes} bytes) for pull`,
      );
    } catch (error) {
      console.error("[session-agent] workspace export failed:", error);
    }
  }

  const wsUrl = controlPlaneEndpoint
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  const transport = await connectWebSocketTransport(
    `${wsUrl}/sessions/${sessionId}/agent`,
  );

  const spawner =
    process.env.SESSION_AGENT_SPAWNER === "child-process"
      ? childProcessSpawner
      : ptySpawner;

  const agent = new SessionAgent({
    sessionId,
    profile,
    workspacePath,
    transport,
    spawner,
    env: process.env as Record<string, string>,
  });

  agent.start();
  await transport.closed;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("session-agent/dist/index.js")) {
  main().catch((error: unknown) => {
    console.error("session-agent fatal:", error);
    process.exitCode = 1;
  });
}
