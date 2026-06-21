/**
 * WP14-B: WebSocket terminal transport.
 *
 * GET /sessions/:id/terminal
 *   Upgrade to WebSocket → spawn `kubectl exec -n <ns> session-<id> -c
 *   session-agent -it -- tmux attach -t 0` → bridge WS ↔ pty stdio.
 *
 * Frame protocol:
 *   - Binary frames: raw terminal data (stdin → pod, stdout ← pod).
 *   - Text JSON frames (client→server only): control messages.
 *     { type: "resize", cols: N, rows: N } → resize the pty inside tmux.
 */

import { spawn } from "node:child_process";
import type { WSEvents } from "hono/ws";

import type { Authenticator } from "../auth/authenticator.js";
import type { SessionStore } from "../sessions/store.js";
import { tenantNamespace } from "../tenancy/namespace.js";

export type TerminalSocketDeps = {
  readonly store: SessionStore;
  readonly authenticator: Authenticator;
};

/** Minimal control message sent by the client over a text frame. */
type ControlMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: string };

function parseControl(data: unknown): ControlMessage | undefined {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(data))
        : undefined;
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ControlMessage;
    }
  } catch {
    // not JSON — treat as binary terminal data below
  }
  return undefined;
}

function toBinary(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // node-ws can deliver Buffer (subclass of Uint8Array)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data))
    return new Uint8Array(data);
  return undefined;
}

/**
 * Build the WSEvents handler for a terminal session.
 * Called from the upgradeWebSocket factory after auth succeeds.
 */
export function buildTerminalSocketEvents(
  sessionId: string,
  namespace: string,
): WSEvents {
  // kubectl exec child process — set after WS opens
  let child: ReturnType<typeof spawn> | null = null;
  let closed = false;

  function teardown(): void {
    if (closed) return;
    closed = true;
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    child = null;
  }

  return {
    onOpen(_event, ws) {
      const podName = `session-${sessionId}`;

      child = spawn(
        "kubectl",
        [
          "exec",
          "-n", namespace,
          podName,
          "-c", "session-agent",
          "-it",
          "--",
          "tmux", "attach", "-t", "0",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      child.stdout?.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          ws.send(new Uint8Array(chunk));
        } catch {
          // WS may already be closing
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          ws.send(new Uint8Array(chunk));
        } catch {
          // WS may already be closing
        }
      });

      child.on("close", (_code) => {
        if (!closed) {
          closed = true;
          child = null;
          try {
            ws.close(1000, "process.exited");
          } catch {
            // already closed
          }
        }
      });

      child.on("error", (err) => {
        console.error(`[terminal] kubectl exec error for ${sessionId}:`, err);
        teardown();
        try {
          ws.close(1011, "exec.failed");
        } catch {
          // already closed
        }
      });
    },

    onMessage(event, _ws) {
      if (closed || !child?.stdin) return;

      // Text frame → try to parse as control message
      if (typeof event.data === "string") {
        const msg = parseControl(event.data);
        if (msg?.type === "resize") {
          const resizeMsg = msg as { type: "resize"; cols: number; rows: number };
          const cols = Math.max(1, Math.floor(resizeMsg.cols));
          const rows = Math.max(1, Math.floor(resizeMsg.rows));
          // Resize the tmux window via a fire-and-forget exec. Best-effort.
          const resizeChild = spawn("kubectl", [
            "exec",
            "-n", namespace,
            `session-${sessionId}`,
            "-c", "session-agent",
            "--",
            "tmux", "resize-window", "-t", "0", "-x", String(cols), "-y", String(rows),
          ]);
          resizeChild.on("error", () => {
            // best-effort: resize failures are non-fatal
          });
        } else if (!msg) {
          // Unrecognised text (not JSON) → pass as raw terminal input
          try {
            child.stdin.write(event.data);
          } catch {
            // stdin may be closed
          }
        }
        return;
      }

      // Binary frame → raw terminal input to kubectl exec stdin
      const bytes = toBinary(event.data);
      if (bytes && bytes.byteLength > 0) {
        try {
          child.stdin.write(bytes);
        } catch {
          // stdin may already be closed
        }
      }
    },

    onClose() {
      teardown();
    },

    onError() {
      teardown();
    },
  };
}

/**
 * Authenticate the WS upgrade request and resolve the namespace + userId.
 * Returns `null` if auth or session lookup fails — caller should reject the WS.
 */
export async function resolveTerminalContext(
  req: Request,
  sessionId: string,
  deps: TerminalSocketDeps,
): Promise<{ userId: string; namespace: string } | null> {
  try {
    const auth = await deps.authenticator.authenticate(req);
    // Off-mode (userId = "default") skips ownership enforcement;
    // in bearer-auth mode the store enforces per-user access.
    const session = deps.store.get(sessionId, auth.userId);
    if (!session) return null;
    return {
      userId: auth.userId,
      namespace: tenantNamespace(auth.userId),
    };
  } catch {
    return null;
  }
}
