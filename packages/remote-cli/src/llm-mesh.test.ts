import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireLlmMeshSessionEnv,
  gatewayScriptPath,
  llmMeshSeedPath,
  llmMeshTokenPath,
  readOrCreateLlmMeshSeed,
} from "./llm-mesh.js";

const SCRATCH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "llm-mesh",
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("llm-mesh seed", () => {
  it("persists only the seed as the durable token secret with 0600 mode", () => {
    const seed = readOrCreateLlmMeshSeed(SCRATCH);
    expect(seed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readOrCreateLlmMeshSeed(SCRATCH)).toBe(seed);
    expect(statSync(llmMeshSeedPath(SCRATCH)).mode & 0o777).toBe(0o600);
  });
});

describe("gateway runtime path", () => {
  it("uses the remote-cli embedded gateway runtime, not apps/llm-gateway", () => {
    expect(gatewayScriptPath()).toMatch(/\/(src|dist)\/llm-gateway-runtime\/index\.js$/);
    expect(gatewayScriptPath()).not.toContain("apps/llm-gateway");
  });
});

describe("acquireLlmMeshSessionEnv", () => {
  it("reacquires the deterministic gateway token and rewrites runtime metadata", async () => {
    writeFileSync(
      llmMeshTokenPath(SCRATCH),
      JSON.stringify({
        gatewayToken: "gw-stale",
        baseUrl: "http://localhost:3002",
        pid: process.pid,
      }),
      "utf8",
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:3002/v1/session");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ gatewayToken: "gw-v1-local-dev.fixed" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = await acquireLlmMeshSessionEnv(SCRATCH);

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:3002",
      ANTHROPIC_AUTH_TOKEN: "gw-v1-local-dev.fixed",
      ANTHROPIC_API_KEY: "gw-v1-local-dev.fixed",
    });
    expect(JSON.parse(readFileSync(llmMeshTokenPath(SCRATCH), "utf8"))).toEqual({
      gatewayToken: "gw-v1-local-dev.fixed",
      baseUrl: "http://localhost:3002",
      pid: process.pid,
    });
  });
});
