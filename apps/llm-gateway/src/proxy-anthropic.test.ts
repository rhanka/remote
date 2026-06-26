import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { handleMessages } from "./proxy-anthropic.js";

// Inject a fake session into the in-memory map via sticky module
vi.mock("./sticky.js", () => ({
  lookupToken: vi.fn(async (t: string) =>
    t === "gw-validtoken"
      ? { gatewayToken: t, accountId: "c1", token: "sk-ant-real", provider: "claude-code" }
      : undefined,
  ),
  acquireSession: vi.fn(),
  sessionCount: vi.fn(() => 0),
}));

const app = new Hono();
app.post("/v1/messages", handleMessages);

afterEach(() => {
  vi.restoreAllMocks();
});

it("returns 403 when no authorization header", async () => {
  const req = new Request("http://localhost/v1/messages", { method: "POST", body: "{}" });
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
});

it("returns 403 on unknown gateway token", async () => {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer gw-unknown" },
    body: "{}",
  });
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
});

it("pipes upstream response on valid token", async () => {
  const upstreamBody = JSON.stringify({ id: "msg_123", type: "message" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer gw-validtoken",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
  });

  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe(upstreamBody);

  // Verify we sent the real API key upstream, not the gateway token
  const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
  const upstreamReq = calls[0]![1] as RequestInit;
  const headers = upstreamReq.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-real");
  expect(headers["authorization"]).toBeUndefined();
});

it("accepts the gateway token via x-api-key and does not forward it upstream", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_123", type: "message" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "gw-validtoken",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
  });

  const res = await app.fetch(req);
  expect(res.status).toBe(200);

  const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
  const upstreamReq = calls[0]![1] as RequestInit;
  const headers = upstreamReq.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-real");
  expect(headers["authorization"]).toBeUndefined();
});

it("forwards 429 + retry-after from upstream", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "30", "content-type": "application/json" },
      }),
    ),
  );

  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer gw-validtoken", "content-type": "application/json" },
    body: "{}",
  });

  const res = await app.fetch(req);
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("30");
});
