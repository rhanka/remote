import { SessionAgent } from "./agent.js";
import { ptySpawner } from "./pty-spawner.js";
import { childProcessSpawner } from "./spawner.js";
import { connectWebSocketTransport } from "./websocket-transport.js";

export const packageName = "@sentropic/remote-session-agent";

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
