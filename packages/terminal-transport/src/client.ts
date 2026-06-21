/**
 * WP14-B — TerminalTransportClient
 *
 * WebSocket-based terminal client for the CP terminal endpoint.
 * Connects to  wss://<cp>/sessions/<id>/terminal
 *
 * Frame protocol (matches the server in apps/control-plane/src/routes/terminal.ts):
 *   - Binary frames OUT: raw terminal stdin bytes to the pod.
 *   - Binary frames IN : raw terminal stdout/stderr bytes from the pod.
 *   - Text JSON frames OUT: control messages only.
 *       { type: "resize", cols: N, rows: N }
 */

/** Callback registered via `onData`. */
type DataCallback = (data: Uint8Array) => void;
/** Callback registered via `onClose`. */
type CloseCallback = () => void;

export class TerminalTransportClient {
  private readonly url: string;
  private readonly token: string;
  private ws: WebSocket | null = null;
  private dataCallbacks: DataCallback[] = [];
  private closeCallbacks: CloseCallback[] = [];

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  /**
   * Open the WebSocket connection.
   *
   * The CP terminal endpoint is authenticated via an `Authorization: Bearer`
   * header passed as a sub-protocol (the WS spec does not allow arbitrary
   * headers from the browser).  When running in Node.js (e.g. the CLI), we
   * use the `headers` option of `ws` which is forwarded on the HTTP upgrade
   * request directly — no sub-protocol trick needed.
   *
   * The client is deliberately environment-agnostic: it accepts any object
   * that satisfies the browser `WebSocket` interface and is constructed with
   * `new`. In practice:
   *   - Browser: pass the global `WebSocket` constructor (no auth header
   *     support — callers must use sub-protocol or query-param tokens).
   *   - Node.js CLI: pass `WebSocket` from the `ws` package, which supports
   *     a third-argument options object including `headers`.
   *
   * To keep the package dependency-free (no hard dep on `ws`), the caller
   * injects the constructor via `wsConstructor`. If omitted the global
   * `WebSocket` is used (browser / Node 21+).
   */
  connect(
    wsConstructor?: new (
      url: string,
      protocols?: string | string[],
      options?: Record<string, unknown>,
    ) => WebSocket,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const Ctor = wsConstructor ?? (globalThis.WebSocket as typeof WebSocket);
      if (!Ctor) {
        reject(new Error("No WebSocket implementation available"));
        return;
      }

      // Attempt to pass the bearer token as an Authorization header (works in
      // Node via the `ws` package). Browsers ignore the options argument.
      const ws = new Ctor(this.url, [], {
        headers: { Authorization: `Bearer ${this.token}` },
      }) as WebSocket;

      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        this.ws = ws;
        resolve();
      });

      ws.addEventListener("error", (event) => {
        if (!this.ws) {
          // Still connecting — surface as a connect error.
          reject(new Error(`WebSocket error: ${String(event)}`));
        }
      });

      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        let bytes: Uint8Array | null = null;
        if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
          bytes = data;
        }
        // node-ws with binaryType="arraybuffer" always delivers ArrayBuffer, so
        // no Buffer branch is needed here for the Node.js use-case.
        if (bytes !== null) {
          for (const cb of this.dataCallbacks) {
            cb(bytes);
          }
        }
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        for (const cb of this.closeCallbacks) {
          cb();
        }
      });
    });
  }

  /** Send raw terminal input bytes to the pod (binary frame). */
  write(data: Uint8Array): void {
    if (!this.ws) throw new Error("Not connected");
    // The DOM WebSocket.send() overload only accepts ArrayBuffer, not the
    // wider ArrayBufferLike (which includes SharedArrayBuffer). We force a
    // copy into a plain ArrayBuffer when the backing store isn't one.
    const backing = data.buffer;
    const buf: ArrayBuffer =
      backing instanceof ArrayBuffer
        ? (data.byteOffset === 0 && data.byteLength === backing.byteLength
            ? backing
            : backing.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : // SharedArrayBuffer path: copy via slice (always returns ArrayBuffer).
          new Uint8Array(data).buffer as ArrayBuffer;
    this.ws.send(buf);
  }

  /** Send a resize control message (text JSON frame). */
  resize(cols: number, rows: number): void {
    if (!this.ws) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  /** Register a callback for terminal output (binary data from the pod). */
  onData(cb: DataCallback): void {
    this.dataCallbacks.push(cb);
  }

  /** Register a callback for when the connection is closed. */
  onClose(cb: CloseCallback): void {
    this.closeCallbacks.push(cb);
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws?.close(1000, "client.close");
    this.ws = null;
  }
}
