import { describe, expect, it, vi } from "vitest";

import { smokeRemoteProfile } from "./smoke.js";

function sseResponse(
  envelopes: ReadonlyArray<Record<string, unknown>>,
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const envelope of envelopes) {
          controller.enqueue(
            encoder.encode(
              `event: ${String(envelope.type)}\ndata: ${JSON.stringify(
                envelope,
              )}\n\n`,
            ),
          );
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function event(type: string, payload: Record<string, unknown>) {
  return {
    protocolVersion: "0.1.0",
    schemaVersion: "0.1.0",
    eventId: `evt-${type}`,
    sessionId: "sess-smoke",
    sequence: 1,
    type,
    occurredAt: "2026-05-17T00:00:00.000Z",
    actor: {
      id: "session-agent",
      kind: "session-agent",
      displayName: "Session Agent",
    },
    payload,
  };
}

describe("remote profile smoke", () => {
  it("creates a profiled remote session with bundled auth, waits for terminal.opened, and stops", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ session: { id: "sess-smoke" } }), {
          status: 201,
        });
      }
      if (url.endsWith("/sessions/sess-smoke/events")) {
        return sseResponse([
          event("terminal.opened", { terminalId: "term-1", shell: "codex" }),
        ]);
      }
      if (
        url.endsWith("/sessions/sess-smoke/stop") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ sessionId: "sess-smoke", accepted: true }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await smokeRemoteProfile({
      profile: "codex",
      baseUrl: "http://control-plane.test",
      target: "scaleway-kapsule",
      displayName: "codex-smoke",
      timeoutMs: 1_000,
      fetchImpl,
      collectAuth: async () => ({ ".codex/auth.json": "BASE64" }),
      ensureAuthFresh: async () => ({
        checked: true,
        command: "codex login status",
      }),
    });

    expect(result).toEqual({
      profile: "codex",
      sessionId: "sess-smoke",
      shell: "codex",
      terminalId: "term-1",
    });
    expect(
      requests.some((request) =>
        request.url.endsWith("/sessions/sess-smoke/stop"),
      ),
    ).toBe(true);

    const createRequest = requests.find((request) =>
      request.url.endsWith("/sessions"),
    );
    expect(JSON.parse(String(createRequest?.init?.body))).toMatchObject({
      profile: "codex",
      target: "scaleway-kapsule",
      displayName: "codex-smoke",
      credentials: { ".codex/auth.json": "BASE64" },
    });
  });

  it("cancels the event stream after terminal.opened so the process can exit", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const openStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: terminal.opened\ndata: ${JSON.stringify(
              event("terminal.opened", {
                terminalId: "term-1",
                shell: "claude",
              }),
            )}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });

    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ session: { id: "sess-smoke" } }), {
          status: 201,
        });
      }
      if (url.endsWith("/sessions/sess-smoke/events")) {
        return new Response(openStream, { status: 200 });
      }
      if (
        url.endsWith("/sessions/sess-smoke/stop") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ sessionId: "sess-smoke", accepted: true }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await smokeRemoteProfile({
      profile: "claude-code",
      baseUrl: "http://control-plane.test",
      timeoutMs: 1_000,
      fetchImpl,
      collectAuth: async () => ({ ".claude/.credentials.json": "BASE64" }),
      ensureAuthFresh: async () => ({
        checked: true,
        command: "claude auth status",
      }),
    });

    expect(cancelled).toBe(true);
  });

  it("stops the remote session when the profile exits before opening a terminal", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ session: { id: "sess-smoke" } }), {
          status: 201,
        });
      }
      if (url.endsWith("/sessions/sess-smoke/events")) {
        return sseResponse([
          event("terminal.exited", { terminalId: "term-1", exitCode: 1 }),
        ]);
      }
      if (
        url.endsWith("/sessions/sess-smoke/stop") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ sessionId: "sess-smoke", accepted: true }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      smokeRemoteProfile({
        profile: "claude-code",
        baseUrl: "http://control-plane.test",
        timeoutMs: 1_000,
        fetchImpl,
        collectAuth: async () => ({ ".claude/.credentials.json": "BASE64" }),
        ensureAuthFresh: async () => ({
          checked: true,
          command: "claude auth status",
        }),
      }),
    ).rejects.toThrow("exited before terminal.opened");

    expect(
      requests.some((request) =>
        request.url.endsWith("/sessions/sess-smoke/stop"),
      ),
    ).toBe(true);
  });
});
