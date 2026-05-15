import type { RemoteEventEnvelope } from "@sentropic/remote-protocol";

export type AttachOptions = {
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly fetchImpl?: typeof fetch;
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
      headers: { accept: "text/event-stream" },
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

  const sendInput = async (data: string) => {
    try {
      await doFetch(joinUrl(baseUrl, `/sessions/${sessionId}/terminal/input`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terminalId: "operator",
          data,
          encoding: "utf8",
        }),
      });
    } catch (error) {
      stderr.write(`[remote] input failed: ${String(error)}\n`);
    }
  };

  const onStdin = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    void sendInput(text);
  };
  stdin.on("data", onStdin);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    stdin.off?.("data", onStdin);
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
          if (ev.event && ev.event !== "terminal.output") continue;
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

export async function createRemoteSession(
  baseUrl: string,
  body: {
    profile: string;
    target?: string;
    resume?: string;
    displayName?: string;
    credentials?: Readonly<Record<string, string>>;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    profile: body.profile,
    target: body.target ?? "k3s",
  };
  if (body.displayName) payload.displayName = body.displayName;
  if (body.resume) payload.metadata = { resume: body.resume };
  if (body.credentials && Object.keys(body.credentials).length > 0)
    payload.credentials = body.credentials;

  const response = await fetchImpl(joinUrl(baseUrl, "/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
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
