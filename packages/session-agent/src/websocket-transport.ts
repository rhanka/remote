import { WebSocket } from "ws";
import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";

import type { AgentTransport, IncomingEnvelope } from "./agent.js";

export function connectWebSocketTransport(
  url: string,
): Promise<AgentTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const handlers: Array<(envelope: IncomingEnvelope) => void> = [];

    let closedResolve: (() => void) | null = null;
    const closed = new Promise<void>((r) => {
      closedResolve = r;
    });

    socket.once("open", () => {
      socket.on("message", (raw) => {
        try {
          const envelope = JSON.parse(raw.toString("utf8")) as IncomingEnvelope;
          for (const handler of handlers) handler(envelope);
        } catch {
          // ignore malformed messages
        }
      });
      socket.on("close", () => closedResolve?.());
      socket.on("error", () => closedResolve?.());

      resolve({
        send(envelope: RemoteEventEnvelope) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(envelope));
          }
        },
        onMessage(handler) {
          handlers.push(handler);
        },
        async close() {
          socket.close();
          await closed;
        },
        closed,
      });
    });

    socket.once("error", (error) => {
      reject(error);
    });
  });
}
