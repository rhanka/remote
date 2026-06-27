import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("GATEWAY_ACCOUNTS", JSON.stringify([
    {
      id: "codex-a",
      provider: "openai",
      label: "Codex A",
      token: "secret-openai-token",
    },
  ]));
  vi.stubEnv("LLM_GATEWAY_TOKEN_SEED", "test-seed");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("gateway descriptor APIs", () => {
  it("exposes descriptor-only accounts and routable models", async () => {
    const { app } = await import("./index.js");

    const accounts = await app.fetch(new Request("http://localhost/v1/accounts"));
    expect(accounts.status).toBe(200);
    await expect(accounts.json()).resolves.toEqual({
      data: [
        {
          id: "codex-a",
          provider: "openai",
          label: "Codex A",
          modelIds: [],
          status: "active",
        },
      ],
    });

    const models = await app.fetch(new Request("http://localhost/v1/models"));
    expect(models.status).toBe(200);
    const modelBody = await models.json() as { data: Array<{ id: string; owned_by: string }> };
    expect(modelBody.data.map((model) => model.id)).toContain("gpt-5.5");
    expect(modelBody.data.map((model) => model.id)).toContain("gpt-5.3-codex-spark");
    expect(JSON.stringify(modelBody)).not.toContain("secret");
  });

  it("records session ledger entries for model-routed acquisitions", async () => {
    const { app } = await import("./index.js");

    const created = await app.fetch(
      new Request("http://localhost/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "sess-ledger",
          model: "gpt-5.3-codex-spark",
          workspaceId: "workspace-a",
          profile: "claude",
        }),
      }),
    );

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      accountId: "codex-a",
      modelId: "gpt-5.3-codex-spark",
      upstreamModel: "gpt-5.3-codex-spark",
      routePolicy: "round-robin",
      routeReason: "catalog-id",
    });

    const session = await app.fetch(new Request("http://localhost/v1/sessions/sess-ledger"));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      gatewaySessionId: "sess-ledger",
      clientSessionId: "sess-ledger",
      workspaceId: "workspace-a",
      profile: "claude",
      account: { id: "codex-a", provider: "openai", label: "Codex A" },
      requestedModel: "gpt-5.3-codex-spark",
      modelId: "gpt-5.3-codex-spark",
      upstreamModel: "gpt-5.3-codex-spark",
      requestCount: 0,
    });

    const sessions = await app.fetch(new Request("http://localhost/v1/sessions"));
    const body = await sessions.json();
    expect(JSON.stringify(body)).not.toContain("secret-openai-token");
    expect(JSON.stringify(body)).not.toContain("gw-v1-");
  });

  it("rejects unsupported session models at acquisition time", async () => {
    const { app } = await import("./index.js");

    const res = await app.fetch(
      new Request("http://localhost/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-bad", model: "mystery-model" }),
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "unsupported model: mystery-model" });
  });
});
