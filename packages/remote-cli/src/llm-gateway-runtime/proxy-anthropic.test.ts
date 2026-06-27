import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUEST_BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 32,
  messages: [{ role: "user", content: "ping" }],
};

function openAIMessage(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_test",
      choices: [
        {
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("proxy-anthropic quota fallback", () => {
  let scratch: string;
  let stickyPath: string;

  beforeEach(() => {
    vi.resetModules();
    scratch = mkdtempSync(join(tmpdir(), "remote-gateway-"));
    stickyPath = join(scratch, "sticky.json");
    vi.stubEnv("LLM_GATEWAY_TOKEN_SEED", "test-seed");
    vi.stubEnv("LLM_GATEWAY_STICKY_FILE", stickyPath);
    vi.stubEnv("OPENAI_UPSTREAM_URL", "https://openai.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  async function appWithSession(accounts: unknown[]) {
    vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify(accounts));
    const accountsModule = await import("./accounts.js");
    accountsModule.resetAccountsCache();
    const { acquireSession } = await import("./sticky.js");
    const { handleMessages } = await import("./proxy-anthropic.js");
    const session = await acquireSession("sess-429");
    const app = new Hono();
    app.post("/v1/messages", handleMessages);
    return { app, gatewayToken: session.gatewayToken };
  }

  it("rebinds and retries on a fallback account when the sticky account returns 429", async () => {
    const { app, gatewayToken } = await appWithSession([
      {
        id: "claude-quota",
        provider: "anthropic",
        label: "Claude quota",
        token: "sk-ant-quota",
      },
      {
        id: "openai-ok",
        provider: "openai",
        label: "OpenAI ok",
        token: "sk-openai-ok",
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "usage limit reached" }), {
          status: 429,
          headers: { "retry-after": "30", "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(openAIMessage("pong"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(REQUEST_BODY),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((firstInit.headers as Record<string, string>)["x-api-key"]).toBe(
      "sk-ant-quota",
    );
    const secondInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-openai-ok",
    );

    expect(JSON.parse(readFileSync(stickyPath, "utf8"))).toEqual({
      "sess-429": "openai-ok",
    });
    const { lookupToken } = await import("./sticky.js");
    await expect(lookupToken(gatewayToken)).resolves.toMatchObject({
      accountId: "openai-ok",
      token: "sk-openai-ok",
      provider: "openai",
    });
  });

  it("preserves the upstream 429 when no fallback account is configured", async () => {
    const { app, gatewayToken } = await appWithSession([
      {
        id: "claude-quota",
        provider: "anthropic",
        label: "Claude quota",
        token: "sk-ant-quota",
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "usage limit reached" }), {
        status: 429,
        headers: { "retry-after": "30", "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(REQUEST_BODY),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    await expect(res.json()).resolves.toEqual({ error: "usage limit reached" });
  });
});
