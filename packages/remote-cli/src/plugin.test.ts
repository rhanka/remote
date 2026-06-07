import { describe, expect, it } from "vitest";

import type { PluginEntry } from "./config.js";
import {
  buildPodSyncScript,
  codexMcpServerBlock,
  detectMcpBins,
  mcpTargetForProfile,
  mergeClaudeMcpServers,
  normalizeBins,
  parseMcpSpec,
  parseMcpSpecs,
  splitNpmSpec,
  upsertCodexMcpServer,
} from "./plugin.js";

describe("splitNpmSpec", () => {
  it("keeps a bare package name", () => {
    expect(splitNpmSpec("track")).toEqual({ pkg: "track" });
  });

  it("splits pkg@version", () => {
    expect(splitNpmSpec("track@0.2.0")).toEqual({
      pkg: "track",
      version: "0.2.0",
    });
  });

  it("is scope-aware (leading @ is not a version separator)", () => {
    expect(splitNpmSpec("@sentropic/track")).toEqual({
      pkg: "@sentropic/track",
    });
    expect(splitNpmSpec("@sentropic/track@0.2.0")).toEqual({
      pkg: "@sentropic/track",
      version: "0.2.0",
    });
  });
});

describe("parseMcpSpec(s)", () => {
  it("parses name=bin", () => {
    expect(parseMcpSpec("track=track-mcp")).toEqual({
      name: "track",
      bin: "track-mcp",
    });
  });

  it("parses several specs and trims whitespace", () => {
    expect(parseMcpSpecs(["a=a-mcp", " b = b-srv "])).toEqual([
      { name: "a", bin: "a-mcp" },
      { name: "b", bin: "b-srv" },
    ]);
  });

  it("rejects malformed specs", () => {
    expect(() => parseMcpSpec("track")).toThrow(/<name>=<bin>/);
    expect(() => parseMcpSpec("=bin")).toThrow(/<name>=<bin>/);
    expect(() => parseMcpSpec("name=")).toThrow(/<name>=<bin>/);
  });

  it("rejects names unsafe for TOML keys / shell words", () => {
    expect(() => parseMcpSpec("ba d=bin")).toThrow(/invalid MCP server name/);
    expect(() => parseMcpSpec("a'b=bin")).toThrow(/invalid MCP server name/);
  });
});

describe("detectMcpBins heuristic", () => {
  it("picks bins ending in -mcp, named after the prefix", () => {
    expect(
      detectMcpBins({ track: "dist/cli.js", "track-mcp": "dist/mcp.js" }),
    ).toEqual([{ name: "track", bin: "track-mcp" }]);
  });

  it("returns nothing when no bin matches", () => {
    expect(detectMcpBins({ track: "dist/cli.js" })).toEqual([]);
  });

  it("ignores a bare '-mcp' bin (empty name)", () => {
    expect(detectMcpBins({ "-mcp": "dist/mcp.js" })).toEqual([]);
  });
});

describe("normalizeBins", () => {
  it("maps a string bin to the package basename", () => {
    expect(normalizeBins("@sentropic/track", "dist/cli.js")).toEqual({
      track: "dist/cli.js",
    });
  });

  it("keeps an object bin map (string values only)", () => {
    expect(
      normalizeBins("@sentropic/track", {
        track: "dist/cli.js",
        "track-mcp": "dist/mcp.js",
        bogus: 42,
      }),
    ).toEqual({ track: "dist/cli.js", "track-mcp": "dist/mcp.js" });
  });

  it("returns {} for missing bin", () => {
    expect(normalizeBins("x", undefined)).toEqual({});
  });
});

describe("codex TOML upsert", () => {
  const ARGS = ["/usr/lib/node_modules/@sentropic/track/dist/mcp.js"];

  it("renders the section block", () => {
    expect(codexMcpServerBlock("track", "node", ARGS)).toBe(
      `[mcp_servers.track]\ncommand = "node"\nargs = ["${ARGS[0]}"]`,
    );
  });

  it("appends to an empty file", () => {
    const out = upsertCodexMcpServer("", "track", "node", ARGS);
    expect(out).toBe(
      `[mcp_servers.track]\ncommand = "node"\nargs = ["${ARGS[0]}"]\n`,
    );
  });

  it("appends after existing content with a separating blank line", () => {
    const existing = 'model = "o3"\n\n[history]\npersistence = "save-all"\n';
    const out = upsertCodexMcpServer(existing, "track", "node", ARGS);
    expect(out).toBe(
      'model = "o3"\n\n[history]\npersistence = "save-all"\n\n' +
        `[mcp_servers.track]\ncommand = "node"\nargs = ["${ARGS[0]}"]\n`,
    );
  });

  it("is idempotent (applying twice changes nothing)", () => {
    const once = upsertCodexMcpServer('model = "o3"\n', "track", "node", ARGS);
    const twice = upsertCodexMcpServer(once, "track", "node", ARGS);
    expect(twice).toBe(once);
  });

  it("replaces an existing section in place, preserving neighbors", () => {
    const existing = [
      'model = "o3"',
      "",
      "[mcp_servers.track]",
      'command = "track-mcp"',
      "args = []",
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const out = upsertCodexMcpServer(existing, "track", "node", ARGS);
    expect(out).toContain(
      `[mcp_servers.track]\ncommand = "node"\nargs = ["${ARGS[0]}"]`,
    );
    expect(out).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(out).not.toContain('command = "track-mcp"');
    expect(out.startsWith('model = "o3"')).toBe(true);
  });
});

describe("claude.json mcpServers merge", () => {
  const SCRIPT = "/usr/lib/node_modules/@sentropic/track/dist/mcp.js";

  it("starts a fresh object from empty input", () => {
    const out = JSON.parse(mergeClaudeMcpServers("", "track", "node", [SCRIPT]));
    expect(out).toEqual({
      mcpServers: { track: { command: "node", args: [SCRIPT] } },
    });
  });

  it("preserves sibling keys and other servers", () => {
    const existing = JSON.stringify({
      numStartups: 12,
      mcpServers: { other: { command: "other-mcp", args: [] } },
    });
    const out = JSON.parse(
      mergeClaudeMcpServers(existing, "track", "node", [SCRIPT]),
    );
    expect(out.numStartups).toBe(12);
    expect(out.mcpServers.other).toEqual({ command: "other-mcp", args: [] });
    expect(out.mcpServers.track).toEqual({ command: "node", args: [SCRIPT] });
  });

  it("overwrites an existing server with the same name (idempotent)", () => {
    const once = mergeClaudeMcpServers("", "track", "node", [SCRIPT]);
    const twice = mergeClaudeMcpServers(once, "track", "node", [SCRIPT]);
    expect(twice).toBe(once);
  });

  it("throws on corrupt JSON instead of clobbering it", () => {
    expect(() => mergeClaudeMcpServers("{nope", "track", "node", [SCRIPT])).toThrow();
  });
});

describe("mcpTargetForProfile", () => {
  it("maps profiles", () => {
    expect(mcpTargetForProfile("claude")).toBe("claude");
    expect(mcpTargetForProfile("claude-code")).toBe("claude");
    expect(mcpTargetForProfile("codex")).toBe("codex");
    expect(mcpTargetForProfile("agy")).toBe("todo");
    expect(mcpTargetForProfile("shell")).toBe("todo");
  });
});

describe("buildPodSyncScript", () => {
  const PLUGIN: PluginEntry = {
    pkg: "@sentropic/track",
    version: "0.2.0",
    mcp: [
      {
        name: "track",
        command: "node",
        args: ["/local/realpath/dist/mcp.js"],
        scriptRel: "dist/mcp.js",
      },
    ],
  };

  it("installs the pinned version and recomputes the realpath in the Pod", () => {
    const script = buildPodSyncScript(PLUGIN, "claude");
    expect(script).toContain("npm install -g '@sentropic/track@0.2.0'");
    expect(script).toContain('ROOT="$(npm root -g)"');
    // The POD-side realpath, not the meaningless local one.
    expect(script).toContain('"$ROOT/@sentropic/track/dist/mcp.js"');
    expect(script).not.toContain("/local/realpath");
    expect(script).toContain("realpathSync");
  });

  it("merges claude.json for claude pods", () => {
    const script = buildPodSyncScript(PLUGIN, "claude");
    expect(script).toContain(".claude.json");
    expect(script).toContain("node -e '");
    expect(script).toContain("'track' \"$REAL\"");
  });

  it("appends an idempotent TOML section for codex pods", () => {
    const script = buildPodSyncScript(PLUGIN, "codex");
    expect(script).toContain('grep -q "^\\[mcp_servers\\.track\\]"');
    expect(script).toContain("[mcp_servers.track]");
    expect(script).toContain('.codex/config.toml');
    expect(script).not.toContain(".claude.json");
  });

  it("only installs (TODO note) for unwired profiles", () => {
    const script = buildPodSyncScript(PLUGIN, "agy");
    expect(script).toContain("npm install -g '@sentropic/track@0.2.0'");
    expect(script).toContain("TODO non câblé");
    expect(script).not.toContain("$REAL");
  });

  it("asks for a re-add when scriptRel is missing", () => {
    const legacy: PluginEntry = {
      pkg: "@sentropic/track",
      version: "0.2.0",
      mcp: [{ name: "track", command: "node", args: ["/local/x.js"] }],
    };
    const script = buildPodSyncScript(legacy, "claude");
    expect(script).toContain("re-run: remote plugin add @sentropic/track");
  });

  it("rejects unsafe package names / versions (shell injection guard)", () => {
    expect(() =>
      buildPodSyncScript({ pkg: "evil; rm -rf /", version: "1.0.0", mcp: [] }, "claude"),
    ).toThrow(/invalid npm package name/);
    expect(() =>
      buildPodSyncScript({ pkg: "ok", version: "1.0.0'; rm", mcp: [] }, "claude"),
    ).toThrow(/invalid version/);
  });
});
