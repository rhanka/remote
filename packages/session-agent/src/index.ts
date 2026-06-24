import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionAnnounce } from "@sentropic/remote-protocol";
import { SessionAgent, parseStartupArgs } from "./agent.js";
import { ptySpawner } from "./pty-spawner.js";
import { childProcessSpawner } from "./spawner.js";
import { connectWebSocketTransport } from "./websocket-transport.js";
import { exportWorkspace, materializeWorkspace } from "./workspace-sync.js";
import { bootstrapGit } from "./git-bootstrap.js";
import {
  canonicalizeConversationKey,
  detectCliSessionId,
  snapshotSessionState,
} from "./session-state.js";
import { clearPresence, writePresence } from "./h2a-presence.js";
import { applyStorageRedirect, planStorageRedirect } from "./redirect-storage.js";

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
  canonicalizeConversationKey,
  projectKeyForCwd,
} from "./session-state.js";
export { writePresence, clearPresence, safePathSegment } from "./h2a-presence.js";
export {
  applyStorageRedirect,
  planStorageRedirect,
} from "./redirect-storage.js";
export type { StoragePlan } from "./redirect-storage.js";

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
 * Tolerant SESSION_LABELS parser: a JSON object whose string-valued entries
 * are kept. Malformed JSON / non-object / no string entries → undefined (the
 * announce simply omits labels, it is never invalidated wholesale).
 */
export function parseLabelsEnv(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") labels[key] = value;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/**
 * Tolerant SESSION_RESOURCE_LIMITS parser: a JSON object with optional
 * non-empty string `cpu` / `memory`. Anything else → undefined (omit).
 */
export function parseResourceLimitsEnv(
  raw: string | undefined,
): { cpu?: string; memory?: string } | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const { cpu, memory } = parsed as { cpu?: unknown; memory?: unknown };
  const limits: { cpu?: string; memory?: string } = {};
  if (typeof cpu === "string" && cpu.length > 0) limits.cpu = cpu;
  if (typeof memory === "string" && memory.length > 0) limits.memory = memory;
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * Build the session.announce base from environment variables.
 * Secret-free: no credentials, tokens, or auth material.
 *
 * Carries `home` (HOME), `startupArgs` (SESSION_STARTUP_ARGS), `displayName`
 * (SESSION_DISPLAY_NAME), `labels` (SESSION_LABELS) and `resourceLimits`
 * (SESSION_RESOURCE_LIMITS) so a control-plane restarted from scratch can
 * rebuild a descriptor whose refreshed Pod keeps the SAME HOME (environment
 * parity), the SAME startup args (e.g. ["--resume", "<convId>"]) and the SAME
 * custom name/labels/limits — without them a post-restart `remote refresh`
 * came back with HOME=/root, a fresh conversation and default resources.
 *
 * Descriptor `metadata` is NOT announced: its only Pod-visible subset is
 * `metadata.startup.args` (already carried as startupArgs); the rest never
 * reaches the Pod environment, so the agent cannot — and must not invent it.
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
  const displayName = input.env.SESSION_DISPLAY_NAME;
  if (displayName !== undefined && displayName.length > 0)
    a.displayName = displayName;
  const labels = parseLabelsEnv(input.env.SESSION_LABELS);
  if (labels !== undefined) a.labels = labels;
  const resourceLimits = parseResourceLimitsEnv(
    input.env.SESSION_RESOURCE_LIMITS,
  );
  if (resourceLimits !== undefined) a.resourceLimits = resourceLimits;
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

  // Redirect heavy/temp/cache/worktree writes off the node's ephemeral overlay
  // disk and onto the per-session RWX workspace BEFORE anything writes: create
  // the cache/tmp/cargo/worktree dirs (the k8s env vars point the tools here,
  // but they don't all mkdir -p their root) and symlink the legacy global
  // superpowers worktree path onto the RWX so worktrees survive a pod restart
  // even when superpowers ignores the env var. Best-effort — never fatal.
  try {
    const created = applyStorageRedirect(
      planStorageRedirect({ workspacePath, home, env: process.env }),
      (msg) => console.error(msg),
    );
    if (created.length > 0) {
      console.log(
        `[session-agent] redirected storage to RWX: ${created.join("; ")}`,
      );
    }
  } catch (error) {
    console.error("[session-agent] storage redirect failed:", error);
  }

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

  // Canonicalize the conversation's project key to THIS Pod's cwd
  // (workspacePath) BEFORE the CLI launches: `remote migrate` stages the live
  // conversation under the user's LOCAL path key, but claude resolves
  // `--resume <id>` only within the cwd's project dir (here `-workspace`), so
  // without this the resume silently drops to a fresh shell (the remote-resume
  // bug). Idempotent + best-effort for a native session (newest conv already
  // under the canonical key → no-op).
  try {
    const canon = canonicalizeConversationKey(profile, home, workspacePath);
    if (canon.copied.length > 0) {
      console.log(
        `[session-agent] canonicalized conversation under ${canon.canonicalKey} for resume: ${canon.copied.join(", ")}`,
      );
    }
  } catch (error) {
    console.error("[session-agent] conversation canonicalize failed:", error);
  }

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

  // Claude headless jobs (-p <task>): use the plain childProcess spawner so
  // stdout is NOT a TTY. Claude auto-skips the workspace trust dialog when
  // stdout is not a TTY (documented behaviour), which is the root cause of
  // the trust-dialog bug on concurrent pods. PTY is only needed for interactive
  // sessions (scroll, resize, Ctrl-C forwarding) — headless jobs don't use it.
  const isClaudeHeadless =
    profile === "claude" &&
    parseStartupArgs(process.env.SESSION_STARTUP_ARGS).includes("-p");
  const spawner =
    process.env.SESSION_AGENT_SPAWNER === "child-process" || isClaudeHeadless
      ? childProcessSpawner
      : ptySpawner;

  const agent = new SessionAgent({
    sessionId,
    profile,
    workspacePath,
    transport,
    onBeforeExit: (exitCode) => {
      // For remote headless jobs: write result.json to the RWX workspace so that
      // `remote jobs status` on the CLI side can reconcile done/failed correctly.
      // Local headless jobs write result.json via the tmux wrapper; remote jobs
      // have no wrapper so the agent must do it directly.
      if (isClaudeHeadless) {
        try {
          const jobDir = join(workspacePath, ".remote", "jobs", sessionId);
          mkdirSync(jobDir, { recursive: true });
          const state = exitCode === 0 ? "done" : "failed";
          writeFileSync(
            join(jobDir, "result.json"),
            JSON.stringify({ state, exitCode }) + "\n",
          );
          console.log(
            `[session-agent] wrote result.json state=${state} exitCode=${exitCode} for headless job ${sessionId}`,
          );
        } catch (error) {
          console.error("[session-agent] result.json write failed:", error);
        }
      }
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
