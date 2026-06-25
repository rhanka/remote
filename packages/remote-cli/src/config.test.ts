import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  setToken,
  getToken,
  getPlugins,
  setPlugins,
  getH2aConfig,
  setH2aConfig,
  getLlmMeshRuntimeConfig,
  setLlmMeshRuntimeConfig,
  getMaxConcurrent,
  setMaxConcurrent,
  readRemoteConfig,
  DEFAULT_H2A_COMMAND,
  type PluginEntry,
} from "./config.js";

// Isolate the config file so these tests never touch the real ~/.config.
// config.ts resolves its directory from REMOTE_CLI_CONFIG_HOME when set.
// Keep the scratch dir inside the package (never /tmp).
const SCRATCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".cfg-test");
let prevHome: string | undefined;
let scratch: string | undefined;

beforeEach(() => {
  prevHome = process.env.REMOTE_CLI_CONFIG_HOME;
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "h-"));
  process.env.REMOTE_CLI_CONFIG_HOME = scratch;
  delete process.env.REMOTE_TOKEN;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.REMOTE_CLI_CONFIG_HOME;
  else process.env.REMOTE_CLI_CONFIG_HOME = prevHome;
  delete process.env.REMOTE_TOKEN;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("token config", () => {
  it("round-trips a stored token", () => {
    setToken("stored");
    delete process.env.REMOTE_TOKEN;
    expect(getToken()).toBe("stored");
  });

  it("env REMOTE_TOKEN overrides stored token", () => {
    setToken("stored");
    process.env.REMOTE_TOKEN = "env-tok";
    expect(getToken()).toBe("env-tok");
  });
});

describe("plugins config", () => {
  it("defaults to an empty list", () => {
    expect(getPlugins()).toEqual([]);
  });

  it("round-trips plugin entries (including scriptRel)", () => {
    const plugins: PluginEntry[] = [
      {
        pkg: "@sentropic/track",
        version: "0.2.0",
        mcp: [
          {
            name: "track",
            command: "node",
            args: ["/usr/lib/node_modules/@sentropic/track/dist/mcp.js"],
            scriptRel: "dist/mcp.js",
          },
        ],
      },
    ];
    setPlugins(plugins);
    expect(getPlugins()).toEqual(plugins);
  });

  it("drops malformed entries on read but keeps valid ones", () => {
    setPlugins([
      { pkg: "good", version: "1.0.0", mcp: [] },
      // malformed entry written through the untyped escape hatch
      { pkg: 42, version: "x" } as unknown as PluginEntry,
    ]);
    expect(getPlugins()).toEqual([{ pkg: "good", version: "1.0.0", mcp: [] }]);
  });
});

describe("h2a config", () => {
  it("defaults to disabled with the launcher-contract command", () => {
    expect(getH2aConfig()).toEqual({
      enabled: false,
      command: DEFAULT_H2A_COMMAND,
    });
    expect(DEFAULT_H2A_COMMAND).toBe(
      "h2a mcp-serve --auto-open --auto-upgrade --wake local-tmux",
    );
  });

  it("round-trips enabled + custom command", () => {
    setH2aConfig({ enabled: true, command: "h2a mcp-serve --wake local-tmux" });
    expect(getH2aConfig()).toEqual({
      enabled: true,
      command: "h2a mcp-serve --wake local-tmux",
    });
  });

  it("merges defaults for omitted keys (partial config)", () => {
    setH2aConfig({ enabled: true });
    expect(getH2aConfig()).toEqual({
      enabled: true,
      command: DEFAULT_H2A_COMMAND,
    });
  });

  it("ignores a malformed h2a key on read", () => {
    setH2aConfig({ enabled: "yes", command: 7 } as never);
    expect(readRemoteConfig().h2a).toBeUndefined();
    expect(getH2aConfig()).toEqual({
      enabled: false,
      command: DEFAULT_H2A_COMMAND,
    });
  });
});

describe("llm-mesh runtime config", () => {
  it("defaults to disabled", () => {
    expect(getLlmMeshRuntimeConfig()).toEqual({ enabled: false });
  });

  it("round-trips enabled", () => {
    setLlmMeshRuntimeConfig({ enabled: true });
    expect(getLlmMeshRuntimeConfig()).toEqual({ enabled: true });
    expect(readRemoteConfig().llmMesh).toEqual({ enabled: true });
  });

  it("ignores malformed config", () => {
    setLlmMeshRuntimeConfig({ enabled: "yes" } as never);
    expect(readRemoteConfig().llmMesh).toBeUndefined();
    expect(getLlmMeshRuntimeConfig()).toEqual({ enabled: false });
  });
});

describe("maxConcurrent config (P4 concurrency cap)", () => {
  beforeEach(() => {
    delete process.env.REMOTE_MAX_CONCURRENT;
  });
  afterEach(() => {
    delete process.env.REMOTE_MAX_CONCURRENT;
  });

  it("is undefined when unset (caller falls back to the default 16)", () => {
    expect(getMaxConcurrent()).toBeUndefined();
  });

  it("round-trips a written value", () => {
    setMaxConcurrent(32);
    expect(getMaxConcurrent()).toBe(32);
    expect(readRemoteConfig().maxConcurrent).toBe(32);
  });

  it("ignores a non-positive / non-finite persisted value", () => {
    setMaxConcurrent(0);
    expect(getMaxConcurrent()).toBeUndefined();
  });

  it("the REMOTE_MAX_CONCURRENT env override wins over config", () => {
    setMaxConcurrent(8);
    process.env.REMOTE_MAX_CONCURRENT = "24";
    expect(getMaxConcurrent()).toBe(24);
    process.env.REMOTE_MAX_CONCURRENT = "garbage";
    expect(getMaxConcurrent()).toBe(8); // bad env → fall back to config
  });
});
