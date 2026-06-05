import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";

import { authHeaders, DEFAULT_SESSION_TARGET } from "./config.js";

export type InputRetryOptions = {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
};

export type AttachOptions = {
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly fetchImpl?: typeof fetch;
  readonly inputRetry?: InputRetryOptions;
};

const DEFAULT_INPUT_RETRY: Required<InputRetryOptions> = {
  maxAttempts: 6,
  baseDelayMs: 200,
  maxDelayMs: 1600,
};

export type AttachResult = {
  readonly close: () => Promise<void>;
  readonly finished: Promise<void>;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function parseSseEvents(buffer: string): {
  events: Array<{ event?: string; data: string }>;
  rest: string;
} {
  const events: Array<{ event?: string; data: string }> = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const entry: { event?: string; data: string } = {
      data: dataLines.join("\n"),
    };
    if (eventName !== undefined) entry.event = eventName;
    events.push(entry);
  }
  return { events, rest };
}

export async function attach(options: AttachOptions): Promise<AttachResult> {
  const baseUrl = options.baseUrl;
  const sessionId = options.sessionId;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const sseResponse = await doFetch(
    joinUrl(baseUrl, `/sessions/${sessionId}/events`),
    {
      headers: { accept: "text/event-stream", ...authHeaders() },
      signal: controller.signal,
    },
  );
  if (!sseResponse.ok || !sseResponse.body) {
    throw new Error(
      `attach: SSE stream returned ${sseResponse.status} ${sseResponse.statusText}`,
    );
  }

  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishedResolve = resolve;
  });

  const wasRaw = stdin.isTTY
    ? Boolean((stdin as { isRaw?: boolean }).isRaw)
    : false;
  if (stdin.isTTY) stdin.setRawMode?.(true);
  stdin.resume();

  if (stdin.isTTY) {
    stderr.write(
      "[remote] press Ctrl+P Ctrl+Q to detach (session keeps running)\n",
    );
  }

  const retry = { ...DEFAULT_INPUT_RETRY, ...(options.inputRetry ?? {}) };
  let aborted = false;
  let queueTail: Promise<void> = Promise.resolve();

  const postInput = async (data: string): Promise<void> => {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (aborted) return;
      try {
        const response = await doFetch(
          joinUrl(baseUrl, `/sessions/${sessionId}/terminal/input`),
          {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({
              terminalId: "operator",
              data,
              encoding: "utf8",
            }),
          },
        );
        if (response.ok) return;
        if (response.status < 500) {
          stderr.write(
            `[remote] input rejected (${response.status} ${response.statusText}); not retried\n`,
          );
          return;
        }
      } catch (error) {
        if (aborted) return;
        if (attempt === retry.maxAttempts) {
          stderr.write(
            `[remote] input abandoned after ${retry.maxAttempts} attempts: ${String(error)}\n`,
          );
          return;
        }
      }
      if (attempt < retry.maxAttempts) {
        const delay = Math.min(
          retry.maxDelayMs,
          retry.baseDelayMs * 2 ** (attempt - 1),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    stderr.write(
      `[remote] input abandoned after ${retry.maxAttempts} attempts\n`,
    );
  };

  const enqueueInput = (data: string): void => {
    queueTail = queueTail.then(() => postInput(data));
  };

  const sendResize = async () => {
    const columns = Math.max(1, stdout.columns ?? 80);
    const rows = Math.max(1, stdout.rows ?? 24);
    try {
      await doFetch(
        joinUrl(baseUrl, `/sessions/${sessionId}/terminal/resize`),
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            terminalId: "operator",
            columns,
            rows,
          }),
        },
      );
    } catch (error) {
      stderr.write(`[remote] resize failed: ${String(error)}\n`);
    }
  };

  const CTRL_P = 0x10;
  const CTRL_Q = 0x11;
  const DETACH_TIMEOUT_MS = 1500;
  let detachPending = false;
  let detachTimer: NodeJS.Timeout | null = null;

  const onStdin = (chunk: Buffer | string) => {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const passthrough: number[] = [];
    const flushPassthrough = () => {
      if (passthrough.length === 0) return;
      enqueueInput(Buffer.from(passthrough).toString("utf8"));
      passthrough.length = 0;
    };
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (detachPending) {
        if (byte === CTRL_Q) {
          detachPending = false;
          if (detachTimer) {
            clearTimeout(detachTimer);
            detachTimer = null;
          }
          flushPassthrough();
          if (stdin.isTTY) stderr.write("\n[remote] detached\n");
          void close();
          return;
        }
        detachPending = false;
        if (detachTimer) {
          clearTimeout(detachTimer);
          detachTimer = null;
        }
        passthrough.push(CTRL_P, byte);
        continue;
      }
      if (byte === CTRL_P) {
        flushPassthrough();
        detachPending = true;
        detachTimer = setTimeout(() => {
          if (!detachPending) return;
          detachPending = false;
          detachTimer = null;
          enqueueInput("\x10");
        }, DETACH_TIMEOUT_MS);
        continue;
      }
      passthrough.push(byte);
    }
    flushPassthrough();
  };
  const onResize = () => {
    void sendResize();
  };
  stdin.on("data", onStdin);
  stdout.on?.("resize", onResize);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (detachTimer) {
      clearTimeout(detachTimer);
      detachTimer = null;
    }
    stdin.off?.("data", onStdin);
    // Give already-queued inputs a brief window to finish before aborting retries
    await Promise.race([
      queueTail.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 500).unref?.()),
    ]);
    aborted = true;
    controller.abort();
    stdout.off?.("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode?.(wasRaw);
    stdin.pause();
    finishedResolve();
  };

  (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseEvents(buffer);
        buffer = rest;
        for (const ev of events) {
          if (
            ev.event &&
            ev.event !== "terminal.output" &&
            ev.event !== "terminal.exited"
          )
            continue;
          try {
            const envelope = JSON.parse(ev.data) as RemoteEventEnvelope;
            if (envelope.type === "terminal.output") {
              const payload = envelope.payload as { data?: string };
              if (typeof payload.data === "string") stdout.write(payload.data);
            } else if (envelope.type === "terminal.exited") {
              await close();
              return;
            }
          } catch {
            // ignore malformed
          }
        }
      }
    } catch {
      // stream aborted or network error -> just close
    } finally {
      await close();
    }
  })();

  return { close, finished };
}

export async function listRemoteSessions(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  ReadonlyArray<{
    id: string;
    profile: string;
    target: string;
    createdAt: string;
    displayName?: string;
    cliSessionId?: string;
  }>
> {
  const response = await fetchImpl(joinUrl(baseUrl, "/sessions"), {
    headers: { ...authHeaders() },
  });
  if (!response.ok) {
    throw new Error(
      `listRemoteSessions: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    sessions: Array<{
      id: string;
      profile: string;
      target: string;
      createdAt: string;
      displayName?: string;
    cliSessionId?: string;
  }>;
  };
  return json.sessions;
}

export async function stopRemoteSession(
  baseUrl: string,
  sessionId: string,
  reason?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accepted: boolean }> {
  const body: Record<string, unknown> = {};
  if (reason) body.reason = reason;
  const response = await fetchImpl(
    joinUrl(baseUrl, `/sessions/${sessionId}/stop`),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `stopRemoteSession: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { accepted: boolean };
  return { accepted: json.accepted };
}

export async function getRemoteSession(
  baseUrl: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ session: { profile: string } }> {
  const response = await fetchImpl(joinUrl(baseUrl, `/sessions/${sessionId}`), {
    headers: { ...authHeaders() },
  });
  if (!response.ok) {
    throw new Error(
      `getRemoteSession: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as { session: { profile: string } };
}

export async function refreshRemoteSession(
  baseUrl: string,
  sessionId: string,
  credentials: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sessionId: string; accepted: boolean }> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `/sessions/${sessionId}/credentials`),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(credentials),
    },
  );
  if (!response.ok) {
    throw new Error(
      `refreshRemoteSession: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    sessionId: string;
    accepted: boolean;
  };
  return { sessionId: json.sessionId, accepted: json.accepted };
}

export async function createRemoteSession(
  baseUrl: string,
  body: {
    profile: string;
    target?: string;
    resume?: string;
    startupArgs?: readonly string[];
    displayName?: string;
    credentials?: Readonly<Record<string, string>>;
    metadata?: Readonly<Record<string, unknown>>;
    workspaceSync?: boolean;
    workspaceExport?: boolean;
    workspaceId?: string;
    workspacePath?: string;
    home?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    profile: body.profile,
    target: body.target ?? DEFAULT_SESSION_TARGET,
  };
  if (body.displayName) payload.displayName = body.displayName;
  if (body.workspaceSync) payload.workspaceSync = true;
  if (body.workspaceExport) payload.workspaceExport = true;
  if (body.workspaceId) payload.workspaceId = body.workspaceId;
  if (body.workspacePath) payload.workspacePath = body.workspacePath;
  if (body.home) payload.home = body.home;
  if (
    body.resume !== undefined ||
    (body.startupArgs?.length ?? 0) > 0 ||
    body.metadata !== undefined
  ) {
    const metadata: Record<string, unknown> = {
      ...(body.metadata ?? {}),
      ...(body.resume !== undefined ? { resume: body.resume } : {}),
      ...(body.startupArgs?.length
        ? { startup: { args: body.startupArgs } }
        : {}),
    };
    payload.metadata = metadata;
  }
  if (body.credentials && Object.keys(body.credentials).length > 0)
    payload.credentials = body.credentials;

  const response = await fetchImpl(joinUrl(baseUrl, "/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `createRemoteSession: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { session: { id: string } };
  return { id: json.session.id };
}
