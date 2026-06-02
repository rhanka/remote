import { WebSocket } from "ws";
import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";

import type { AgentTransport, IncomingEnvelope } from "./agent.js";

export type WebSocketTransportOptions = {
  /**
   * Called immediately after each socket opens (before any other messages are
   * sent). Use this to send the `session.announce` frame on every (re)connect.
   * The `send` argument is a raw JSON-send that bypasses the readyState guard,
   * since we know the socket just opened.
   */
  readonly onOpen?: (send: (data: string) => void) => void;
  /**
   * Inject a custom WebSocket factory for testing. Defaults to the `ws` package
   * WebSocket constructor called with the url string.
   */
  readonly createSocket?: (url: string) => WebSocket;
  /** Base reconnect delay in ms (default 1000). */
  readonly baseDelayMs?: number;
  /** Maximum reconnect delay in ms (default 30000). */
  readonly maxDelayMs?: number;
};

/**
 * Full-jitter exponential backoff delay.
 * Returns a random value in [0, min(cap, base * 2^attempt)].
 */
function jitteredDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
): number {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.random() * ceiling;
}

/**
 * Create a self-healing WebSocket transport that:
 * - Reconnects automatically with full-jitter exponential backoff whenever
 *   the socket closes/errors, UNLESS `close()` was called deliberately.
 * - Calls `options.onOpen` after each successful open so a `session.announce`
 *   frame is sent first on every (re)connect.
 * - Resolves its `closed` promise ONLY when `close()` is called deliberately.
 * - Forwards inbound messages to all registered handlers across reconnects.
 * - `send` while disconnected: best-effort drop (no unbounded buffer).
 *
 * The returned promise resolves once the FIRST connection opens successfully
 * (so `main()` can proceed); subsequent drops reconnect transparently.
 */
export function connectWebSocketTransport(
  url: string,
  options?: WebSocketTransportOptions,
): Promise<AgentTransport> {
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const createSocket = options?.createSocket ?? ((u: string) => new WebSocket(u));
  const onOpen = options?.onOpen;

  const handlers: Array<(envelope: IncomingEnvelope) => void> = [];

  let closed = false;
  let currentSocket: WebSocket | null = null;

  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  /**
   * Wire up a newly opened socket: attach message/close/error listeners,
   * invoke onOpen callback.
   */
  function attachSocket(socket: WebSocket): void {
    currentSocket = socket;

    socket.on("message", (raw) => {
      try {
        const envelope = JSON.parse(
          (raw as Buffer).toString("utf8"),
        ) as IncomingEnvelope;
        for (const handler of handlers) handler(envelope);
      } catch {
        // ignore malformed messages
      }
    });

    socket.on("close", () => {
      currentSocket = null;
      if (!closed) {
        void scheduleReconnect(0);
      }
    });

    socket.on("error", () => {
      // 'error' is always followed by 'close' in the ws library; the 'close'
      // handler drives reconnection. No action needed here.
    });

    // Call onOpen with a raw send so the announce goes first.
    if (onOpen) {
      onOpen((data: string) => {
        socket.send(data);
      });
    }
  }

  /**
   * Reconnect loop: try to open a new socket, retrying with backoff on failure.
   * Each failed attempt increments the attempt counter for exponential backoff.
   */
  async function scheduleReconnect(attempt: number): Promise<void> {
    if (closed) return;

    const delay = attempt === 0 ? 0 : jitteredDelay(attempt - 1, baseDelayMs, maxDelayMs);
    if (delay > 0) {
      await new Promise<void>((r) => setTimeout(r, delay));
    }
    if (closed) return;

    await new Promise<void>((resolve) => {
      let socket: WebSocket;
      try {
        socket = createSocket(url);
      } catch {
        // factory threw — retry
        void scheduleReconnect(attempt + 1);
        resolve();
        return;
      }

      socket.once("open", () => {
        if (closed) {
          socket.close();
          resolve();
          return;
        }
        attachSocket(socket);
        resolve();
      });

      socket.once("error", () => {
        // Initial connect failed; 'close' will fire next but we schedule
        // retry ourselves to avoid double-scheduling.
        // Remove the generic close-on-error handler to prevent double reconnect.
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        resolve();
        void scheduleReconnect(attempt + 1);
      });
    });
  }

  return new Promise<AgentTransport>((resolve, reject) => {
    if (closed) {
      reject(new Error("transport already closed"));
      return;
    }

    let socket: WebSocket;
    try {
      socket = createSocket(url);
    } catch (err) {
      reject(err);
      return;
    }

    socket.once("open", () => {
      if (closed) {
        socket.close();
        reject(new Error("transport closed before first open"));
        return;
      }
      attachSocket(socket);

      const transport: AgentTransport = {
        send(envelope: RemoteEventEnvelope): void {
          if (currentSocket?.readyState === WebSocket.OPEN) {
            currentSocket.send(JSON.stringify(envelope));
          }
          // else: drop — best-effort, terminal output during downtime is lost
        },
        onMessage(handler: (envelope: IncomingEnvelope) => void): void {
          handlers.push(handler);
        },
        async close(): Promise<void> {
          if (closed) {
            await closedPromise;
            return;
          }
          closed = true;
          if (currentSocket) {
            currentSocket.close();
            currentSocket = null;
          }
          closedResolve();
          await closedPromise;
        },
        get closed(): Promise<void> {
          return closedPromise;
        },
      };

      resolve(transport);
    });

    socket.once("error", (error) => {
      reject(error);
    });
  });
}
