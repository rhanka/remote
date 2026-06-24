import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireLlmMeshSessionEnv,
  llmMeshTokenPath,
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

describe("acquireLlmMeshSessionEnv", () => {
  it("reacquires a fresh in-memory gateway token and rewrites the token file", async () => {
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
      return new Response(JSON.stringify({ gatewayToken: "gw-fresh" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = await acquireLlmMeshSessionEnv(SCRATCH);

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:3002",
      ANTHROPIC_AUTH_TOKEN: "gw-fresh",
    });
    expect(JSON.parse(readFileSync(llmMeshTokenPath(SCRATCH), "utf8"))).toEqual({
      gatewayToken: "gw-fresh",
      baseUrl: "http://localhost:3002",
      pid: process.pid,
    });
  });
});
