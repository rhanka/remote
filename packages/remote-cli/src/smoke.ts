import type {
  CliProfile,
  RemoteEventEnvelope,
  SessionTarget,
  TerminalOpened,
} from "./protocol-local.js";

import { createRemoteSession, stopRemoteSession } from "./attach.js";
import {
  assertRequiredAuthBundle,
  collectProfileAuth,
  type AuthBundle,
} from "./auth-bundle.js";
import {
  ensureProfileAuthFresh,
  type AuthRefreshResult,
} from "./auth-refresh.js";

export type SmokeRemoteProfileOptions = {
  readonly profile: CliProfile;
  readonly baseUrl: string;
  readonly target?: SessionTarget;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly auth?: boolean;
  readonly authRefresh?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly collectAuth?: (profile: CliProfile) => Promise<AuthBundle>;
  readonly ensureAuthFresh?: (
    profile: CliProfile,
  ) => Promise<AuthRefreshResult>;
};

export type SmokeRemoteProfileResult = {
  readonly profile: CliProfile;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly shell: string;
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
    events.push({
      ...(eventName !== undefined ? { event: eventName } : {}),
      data: dataLines.join("\n"),
    });
  }
  return { events, rest };
}

async function waitForTerminalOpened(options: {
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}): Promise<TerminalOpened> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      joinUrl(options.baseUrl, `/sessions/${options.sessionId}/events`),
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `[remote] smoke event stream returned ${response.status} ${response.statusText}`,
      );
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        if (
          ev.event &&
          ev.event !== "terminal.opened" &&
          ev.event !== "terminal.exited"
        ) {
          continue;
        }

        const envelope = JSON.parse(ev.data) as RemoteEventEnvelope;
        if (envelope.type === "terminal.opened") {
          return envelope.payload as TerminalOpened;
        }
        if (envelope.type === "terminal.exited") {
          const payload = envelope.payload as { exitCode?: number };
          throw new Error(
            `[remote] smoke session ${options.sessionId} exited before terminal.opened (exitCode=${payload.exitCode ?? "unknown"})`,
          );
        }
      }
    }

    throw new Error(
      `[remote] smoke event stream ended before terminal.opened for ${options.sessionId}`,
    );
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `[remote] smoke timed out waiting for terminal.opened for ${options.sessionId}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

export async function smokeRemoteProfile(
  options: SmokeRemoteProfileOptions,
): Promise<SmokeRemoteProfileResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let credentials: Readonly<Record<string, string>> | undefined;
  if (options.auth !== false) {
    if (options.authRefresh !== false) {
      await (options.ensureAuthFresh ?? ensureProfileAuthFresh)(
        options.profile,
      );
    }
    const bundle = await (options.collectAuth ?? collectProfileAuth)(
      options.profile,
    );
    assertRequiredAuthBundle(options.profile, bundle);
    if (Object.keys(bundle).length > 0) credentials = bundle;
  }

  let sessionId: string | undefined;
  let result: SmokeRemoteProfileResult | undefined;
  let failure: unknown;
  try {
    sessionId = (
      await createRemoteSession(
        options.baseUrl,
        {
          profile: options.profile,
          target: options.target ?? "k3s",
          displayName:
            options.displayName ?? `smoke-${options.profile}-${Date.now()}`,
          ...(credentials ? { credentials } : {}),
        },
        fetchImpl,
      )
    ).id;
    const opened = await waitForTerminalOpened({
      baseUrl: options.baseUrl,
      sessionId,
      timeoutMs: options.timeoutMs ?? 120_000,
      fetchImpl,
    });
    result = {
      profile: options.profile,
      sessionId,
      terminalId: opened.terminalId,
      shell: opened.shell,
    };
  } catch (error) {
    failure = error;
  }

  if (sessionId) {
    try {
      await stopRemoteSession(
        options.baseUrl,
        sessionId,
        "remote-profile-smoke",
        fetchImpl,
      );
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  if (failure) throw failure;
  return result!;
}
