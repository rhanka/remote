import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleMessagesViaOpenAI,
  mapModel,
  toCodexRequest,
  translateCodexStreamToAnthropic,
  trimCodexBodyForContext,
} from "./proxy-openai.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function failingStream(err: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(err);
    },
  });
}

function codexApp(): Hono {
  const app = new Hono();
  app.post("/v1/messages", (c) =>
    handleMessagesViaOpenAI(c, {
      token: "codex.header.signature",
      gatewayToken: "gw-test",
      accountId: "codex-oauth",
    }),
  );
  return app;
}

describe("OpenAI/Codex model mapping", () => {
  it("maps Claude Sonnet/Haiku defaults to gpt-5.5 for Codex OAuth", () => {
    expect(mapModel("claude-sonnet-4-6")).toBe("gpt-5.5");
    expect(mapModel("claude-sonnet-4-5")).toBe("gpt-5.5");
    expect(mapModel("claude-haiku-4-5-20251001")).toBe("gpt-5.5");
  });

  it("keeps xhigh Claude requests on a Codex-supported model", () => {
    const req = toCodexRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 4096,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 50_000 },
    });

    expect(req).toMatchObject({
      model: "gpt-5.5",
      reasoning: { effort: "high" },
    });
  });

  it("keeps explicit GPT model names instead of remapping them to the default", () => {
    expect(mapModel("gpt-5.5")).toBe("gpt-5.5");
    expect(mapModel("gpt-5.3-codex-spark")).toBe("gpt-5.3-codex-spark");
  });

  it("serializes Anthropic system blocks into Codex instructions text", () => {
    const req = toCodexRequest({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "You are precise." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 4096,
      stream: true,
    });

    expect(req.instructions).toBe("You are precise.\n\nUse tools carefully.");
  });

  it("trims oversized Codex contexts to recent messages", () => {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [
        { role: "user" as const, content: "old".repeat(1000) },
        { role: "assistant" as const, content: "middle".repeat(1000) },
        { role: "user" as const, content: "latest question" },
      ],
    };

    const result = trimCodexBodyForContext(body, 260);

    expect(result.trimmed).toBe(true);
    expect(result.afterChars).toBeLessThan(result.beforeChars);
    expect(result.body.messages.at(-1)).toEqual({ role: "user", content: "latest question" });
    expect(JSON.stringify(result.body.messages)).toContain("older Claude Code transcript omitted");
    expect(JSON.stringify(result.body.messages)).not.toContain("oldoldold");
  });

  it("collects Codex SSE into Anthropic JSON for non-streaming requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          streamFrom(
            [
              "event: response.output_text.delta",
              'data: {"type":"response.output_text.delta","output_index":0,"delta":"pong"}',
              "",
              "event: response.completed",
              'data: {"type":"response.completed","response":{"usage":{"output_tokens":1}}}',
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const res = await codexApp().fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "ping" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn",
      usage: { output_tokens: 1 },
    });
  });

  it("retries transient Codex fetch errors", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "EAI_AGAIN", hostname: "chatgpt.com" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          streamFrom(
            [
              "event: response.output_text.delta",
              'data: {"type":"response.output_text.delta","output_index":0,"delta":"pong"}',
              "",
              "event: response.completed",
              'data: {"type":"response.completed","response":{"usage":{"output_tokens":1}}}',
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await codexApp().fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "ping" }],
        }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
    });
  });

  it("returns a JSON gateway error when non-streaming Codex SSE fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          streamFrom(
            [
              "event: response.failed",
              'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"codex account unavailable"}}}',
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const res = await codexApp().fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "ping" }],
        }),
      }),
    );

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "api_error", message: "codex account unavailable" },
    });
  });

  it("emits an Anthropic SSE error when streaming Codex SSE fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          streamFrom(
            [
              "event: response.failed",
              'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"codex account unavailable"}}}',
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const res = await codexApp().fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "ping" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"codex account unavailable"}}',
    );
  });

  it("closes Codex stream read failures with an Anthropic SSE error", async () => {
    const stream = translateCodexStreamToAnthropic(
      failingStream(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ETIMEDOUT", hostname: "chatgpt.com" },
        }),
      ),
      "claude-sonnet-4-6",
      "msg_test",
      1,
    );

    expect(await new Response(stream).text()).toContain(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Upstream stream failed: ETIMEDOUT chatgpt.com"}}',
    );
  });
});
