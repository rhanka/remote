import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  setToken,
  getToken,
  getPlugins,
  setPlugins,
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
