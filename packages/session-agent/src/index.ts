import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionAnnounce } from "@sentropic/remote-protocol";
import { SessionAgent, parseStartupArgs } from "./agent.js";
import { ptySpawner } from "./pty-spawner.js";
import { childProcessSpawner } from "./spawner.js";
import { connectWebSocketTransport } from "./websocket-transport.js";
import { exportWorkspace, materializeWorkspace } from "./workspace-sync.js";
import { bootstrapGit } from "./git-bootstrap.js";
import {
  detectCliSessionId,
  snapshotSessionState,
} from "./session-state.js";
import { clearPresence, writePresence } from "./h2a-presence.js";

export const packageName = "@sentropic/remote-session-agent";

export { materializeWorkspace, exportWorkspace } from "./workspace-sync.js";
export type {
  MaterializeWorkspaceOptions,
  ExportWorkspaceOptions,
} from "./workspace-sync.js";
export {
  linkSessionState,
  restoreSessionState,
  snapshotSessionState,
  detectCliSessionId,
} from "./session-state.js";
export { writePresence, clearPresence, safePathSegment } from "./h2a-presence.js";

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

export { SessionAgent, parseStartupArgs } from "./agent.js";
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

/**
 * Build the session.announce base from environment variables.
 * Secret-free: no credentials, tokens, or auth material.
 *
 * Carries `home` (HOME) and `startupArgs` (SESSION_STARTUP_ARGS) so a
 * control-plane restarted from scratch can rebuild a descriptor whose
 * refreshed Pod keeps the SAME HOME (environment parity) and the SAME startup
 * args (e.g. ["--resume", "<convId>"]) — without them a post-restart
 * `remote refresh` came back with HOME=/root and a fresh conversation.
 *
 * Constructed imperatively to satisfy exactOptionalPropertyTypes.
 */
export function buildAnnounce(input: {
  readonly sessionId: string;
  readonly profile: string;
  readonly workspacePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): SessionAnnounce {
  const a: SessionAnnounce = {
    sessionId: input.sessionId,
    profile: input.profile as SessionAnnounce["profile"],
    workspacePath: input.workspacePath,
    home: input.env.HOME ?? "/root",
  };
  const target = input.env.SESSION_TARGET as
    | SessionAnnounce["target"]
    | undefined;
  if (target !== undefined) a.target = target;
  const workspaceId = input.env.SESSION_WORKSPACE_ID;
  if (workspaceId !== undefined) a.workspaceId = workspaceId;
  const startupArgs = parseStartupArgs(input.env.SESSION_STARTUP_ARGS);
  if (startupArgs.length > 0) a.startupArgs = startupArgs;
  return a;
}

export async function main(): Promise<void> {
  const sessionId = requireEnv("SESSION_ID");
  const profile = requireEnv("SESSION_PROFILE");
  const workspacePath = process.env.WORKSPACE_PATH ?? "/workspace";
  const controlPlaneEndpoint = requireEnv("CONTROL_PLANE_ENDPOINT");
  const home = process.env.HOME ?? "/root";
  // Per-session service token (only injected under bearer auth). Sent as
  // Authorization: Bearer on every control-plane callback so the auth
  // middleware resolves it back to this session's owner.
  const token = process.env.REMOTE_TOKEN;
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

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
        ...(token ? { token } : {}),
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

  // Clone-on-start: if the archive carried no .git (large history skipped by the
  // CLI) but recorded the origin, fetch history from origin (gh auth bundled)
  // so the repo is real (commit/push) without transferring the .git.
  try {
    const gitMsg = bootstrapGit(workspacePath);
    if (gitMsg) console.log(`[session-agent] ${gitMsg}`);
  } catch (error) {
    console.error("[session-agent] git bootstrap failed:", error);
  }

  if (process.env.SESSION_WORKSPACE_EXPORT === "1") {
    try {
      const bytes = await exportWorkspace({
        controlPlaneEndpoint,
        sessionId,
        workspacePath,
        ...(token ? { token } : {}),
      });
      console.log(
        `[session-agent] exported ${workspacePath} (${bytes} bytes) for pull`,
      );
    } catch (error) {
      console.error("[session-agent] workspace export failed:", error);
    }
  }

  // Conversation durability is handled DECLARATIVELY: the orchestrator mounts the
  // CLI's conversation dir (e.g. ~/.claude/projects) from the retained RWX PVC
  // via a subPath volume mount (see k8s-orchestrator spec.ts). So the log is on
  // the durable volume from PID 1 — no startup copy/symlink, and in-session
  // history survives pod restart/re-deport by construction.

  // Project this session as an h2a presence file in the workspace (DEC-059),
  // so other sessions / an h2a sidecar can discover who's on this workspace.
  const presenceInput = {
    sessionId,
    profile,
    workspacePath,
    ...(process.env.SESSION_WORKSPACE_ID
      ? { workspaceId: process.env.SESSION_WORKSPACE_ID }
      : {}),
  };
  try {
    writePresence(presenceInput, "live");
  } catch (error) {
    console.error("[session-agent] h2a presence write failed:", error);
  }

  const wsUrl = controlPlaneEndpoint
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");

  // Build the session.announce base from environment variables (see
  // buildAnnounce — carries home + startupArgs for restart durability).
  const announceBase: SessionAnnounce = buildAnnounce({
    sessionId,
    profile,
    workspacePath,
    env: process.env,
  });

  const transport = await connectWebSocketTransport(
    `${wsUrl}/sessions/${sessionId}/agent`,
    {
      onOpen(send) {
        // Refresh cliSessionId on each reconnect so the announce is current.
        const cliSessionId = detectCliSessionId(profile, process.env.HOME ?? "/root");
        const body: SessionAnnounce = { ...announceBase };
        if (cliSessionId !== undefined) body.cliSessionId = cliSessionId;
        const frame: { type: string; body: SessionAnnounce } = {
          type: "session.announce",
          body,
        };
        send(JSON.stringify(frame));
      },
    },
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
    onBeforeExit: () => {
      try {
        const saved = snapshotSessionState(profile, home, workspacePath);
        if (saved.length > 0) {
          console.log(
            `[session-agent] snapshotted session state: ${saved.join(", ")}`,
          );
        }
      } catch (error) {
        console.error("[session-agent] session-state snapshot failed:", error);
      }
      try {
        clearPresence(presenceInput);
      } catch {
        // best-effort
      }
    },
    spawner,
    env: process.env as Record<string, string>,
  });

  agent.start();

  // Detect the wrapped CLI's own conversation id (appears shortly after start)
  // and report it to the control-plane so `remote ls` can show it.
  void (async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const cliSessionId = detectCliSessionId(profile, home);
      if (!cliSessionId) continue;
      try {
        await fetch(
          `${controlPlaneEndpoint.replace(/\/$/, "")}/sessions/${sessionId}/cli-session`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders },
            body: JSON.stringify({ cliSessionId }),
          },
        );
      } catch {
        // best-effort
      }
      return;
    }
  })();

  // Gate process lifetime on the wrapped PTY exiting, NOT on the socket
  // closing. A transient control-plane restart drops the socket but the agent
  // self-heals (reconnects + re-announces). Only the deliberate PTY exit path
  // (terminal.exited → transport.close()) resolves agent.done.
  await agent.done;
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("session-agent/dist/index.js")) {
  main().catch((error: unknown) => {
    console.error("session-agent fatal:", error);
    process.exitCode = 1;
  });
}
