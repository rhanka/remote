import { describe, expect, it } from "vitest";

import type { PluginEntry } from "./config.js";
import {
  canonicalManifestJson,
  checkExitCode,
  diffManifest,
  isDrift,
  manifestHash,
  parseNpmLsVersions,
  parseRegisteredMcpServers,
  renderManifest,
  type DriftRow,
  type PluginManifest,
  type PodPluginState,
} from "./plugin-manifest.js";

// ---------------------------------------------------------------------------
// renderManifest / manifestHash — determinism + key/order independence
// ---------------------------------------------------------------------------

function plugin(
  pkg: string,
  version: string,
  mcp: Array<{ name: string; scriptRel?: string }> = [],
): PluginEntry {
  return {
    pkg,
    version,
    mcp: mcp.map((m) => ({
      name: m.name,
      command: "node",
      args: ["/some/path.js"],
      ...(m.scriptRel !== undefined ? { scriptRel: m.scriptRel } : {}),
    })),
  };
}

describe("renderManifest", () => {
  it("renders plugins (pkg+version) and MCP servers (name+bin from scriptRel)", () => {
    const m = renderManifest([
      plugin("@sentropic/track", "0.2.0", [{ name: "track", scriptRel: "dist/mcp.js" }]),
    ]);
    expect(m).toEqual({
      plugins: [{ pkg: "@sentropic/track", version: "0.2.0" }],
      mcp: [{ name: "track", bin: "dist/mcp.js" }],
    });
  });

  it("falls back to the server name as bin when no scriptRel is recorded", () => {
    const m = renderManifest([plugin("h2a", "1.0.0", [{ name: "h2a" }])]);
    expect(m.mcp).toEqual([{ name: "h2a", bin: "h2a" }]);
  });

  it("sorts plugins by pkg and MCP servers by name (order-independent)", () => {
    const m = renderManifest([
      plugin("zeta", "1.0.0", [{ name: "zmcp", scriptRel: "z.js" }]),
      plugin("alpha", "2.0.0", [{ name: "amcp", scriptRel: "a.js" }]),
    ]);
    expect(m.plugins.map((p) => p.pkg)).toEqual(["alpha", "zeta"]);
    expect(m.mcp.map((x) => x.name)).toEqual(["amcp", "zmcp"]);
  });

  it("omits skills when none are tracked, includes + sorts + dedups when present", () => {
    expect(renderManifest([]).skills).toBeUndefined();
    const m = renderManifest([], ["b-skill", "a-skill", "b-skill"]);
    expect(m.skills).toEqual(["a-skill", "b-skill"]);
  });
});

describe("manifestHash — deterministic, order-independent", () => {
  it("same input → same hash", () => {
    const a = renderManifest([plugin("p", "1.0.0", [{ name: "m", scriptRel: "m.js" }])]);
    const b = renderManifest([plugin("p", "1.0.0", [{ name: "m", scriptRel: "m.js" }])]);
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it("plugin/MCP ORDER in the config does not change the hash", () => {
    const ordered = renderManifest([
      plugin("alpha", "1.0.0", [{ name: "amcp", scriptRel: "a.js" }]),
      plugin("zeta", "2.0.0", [{ name: "zmcp", scriptRel: "z.js" }]),
    ]);
    const shuffled = renderManifest([
      plugin("zeta", "2.0.0", [{ name: "zmcp", scriptRel: "z.js" }]),
      plugin("alpha", "1.0.0", [{ name: "amcp", scriptRel: "a.js" }]),
    ]);
    expect(manifestHash(ordered)).toBe(manifestHash(shuffled));
  });

  it("a version bump DOES change the hash", () => {
    const v1 = renderManifest([plugin("p", "1.0.0")]);
    const v2 = renderManifest([plugin("p", "1.0.1")]);
    expect(manifestHash(v1)).not.toBe(manifestHash(v2));
  });

  it("canonical JSON has a fixed key order (plugins, mcp[, skills])", () => {
    const m: PluginManifest = {
      plugins: [{ pkg: "p", version: "1.0.0" }],
      mcp: [{ name: "m", bin: "m.js" }],
      skills: ["s"],
    };
    expect(canonicalManifestJson(m)).toBe(
      '{"plugins":[{"pkg":"p","version":"1.0.0"}],"mcp":[{"name":"m","bin":"m.js"}],"skills":["s"]}',
    );
  });

  it("hash is a 64-char hex sha256", () => {
    expect(manifestHash(renderManifest([]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// diffManifest — ok / version-drift / missing / mcp-unregistered matrix
// ---------------------------------------------------------------------------

const manifest = renderManifest([
  plugin("@sentropic/track", "0.2.0", [{ name: "track", scriptRel: "dist/mcp.js" }]),
  plugin("h2a", "1.0.0", [{ name: "h2a", scriptRel: "bin/h2a-mcp.js" }]),
]);

describe("diffManifest — status matrix", () => {
  it("ok: installed at the desired version AND mcp registered", () => {
    const state: PodPluginState = {
      pluginVersions: { "@sentropic/track": "0.2.0", h2a: "1.0.0" },
      mcpRegistered: ["track", "h2a"],
    };
    const rows = diffManifest(manifest, "session-x", state);
    expect(rows.every((r) => r.status === "ok")).toBe(true);
    expect(rows.map((r) => r.item)).toEqual([
      "plugin:@sentropic/track",
      "plugin:h2a",
      "mcp:h2a",
      "mcp:track",
    ]);
  });

  it("version-drift: installed but a different version", () => {
    const state: PodPluginState = {
      pluginVersions: { "@sentropic/track": "0.1.0", h2a: "1.0.0" },
      mcpRegistered: ["track", "h2a"],
    };
    const row = diffManifest(manifest, "session-x", state).find(
      (r) => r.item === "plugin:@sentropic/track",
    );
    expect(row?.status).toBe("version-drift");
    expect(row?.detail).toBe("local@0.2.0 vs pod@0.1.0");
  });

  it("missing: plugin not installed in the pod", () => {
    const state: PodPluginState = {
      pluginVersions: { h2a: "1.0.0" },
      mcpRegistered: ["track", "h2a"],
    };
    const row = diffManifest(manifest, "session-x", state).find(
      (r) => r.item === "plugin:@sentropic/track",
    );
    expect(row?.status).toBe("missing");
  });

  it("mcp-unregistered: desired MCP name not in the pod's registered set", () => {
    const state: PodPluginState = {
      pluginVersions: { "@sentropic/track": "0.2.0", h2a: "1.0.0" },
      mcpRegistered: ["track"], // h2a NOT registered
    };
    const row = diffManifest(manifest, "session-x", state).find(
      (r) => r.item === "mcp:h2a",
    );
    expect(row?.status).toBe("mcp-unregistered");
  });

  it("tags every row with the pod id", () => {
    const rows = diffManifest(manifest, "session-abc", {
      pluginVersions: {},
      mcpRegistered: [],
    });
    expect(rows.every((r) => r.pod === "session-abc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkExitCode — exit 1 on ANY drift, else 0
// ---------------------------------------------------------------------------

describe("checkExitCode + isDrift", () => {
  const ok: DriftRow = { pod: "p", item: "plugin:x", status: "ok", detail: "" };
  const drift: DriftRow = {
    pod: "p",
    item: "plugin:x",
    status: "missing",
    detail: "",
  };

  it("isDrift true for any non-ok status", () => {
    expect(isDrift(ok)).toBe(false);
    expect(isDrift(drift)).toBe(true);
  });

  it("exit 0 when all rows ok (and when empty)", () => {
    expect(checkExitCode([ok, ok])).toBe(0);
    expect(checkExitCode([])).toBe(0);
  });

  it("exit 1 when ANY row is drift", () => {
    expect(checkExitCode([ok, drift, ok])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseNpmLsVersions — probe parser
// ---------------------------------------------------------------------------

describe("parseNpmLsVersions", () => {
  it("extracts versions for the wanted packages only", () => {
    const json = JSON.stringify({
      dependencies: {
        "@sentropic/track": { version: "0.2.0" },
        h2a: { version: "1.0.0" },
        npm: { version: "10.0.0" }, // not wanted
      },
    });
    expect(parseNpmLsVersions(json, ["@sentropic/track", "h2a"])).toEqual({
      "@sentropic/track": "0.2.0",
      h2a: "1.0.0",
    });
  });

  it("omits a wanted pkg that is absent (→ downstream 'missing')", () => {
    const json = JSON.stringify({ dependencies: { h2a: { version: "1.0.0" } } });
    expect(parseNpmLsVersions(json, ["@sentropic/track", "h2a"])).toEqual({
      h2a: "1.0.0",
    });
  });

  it("skips a pkg with no string version (never a false ok)", () => {
    const json = JSON.stringify({ dependencies: { p: { invalid: true } } });
    expect(parseNpmLsVersions(json, ["p"])).toEqual({});
  });

  it("returns {} on unparseable / empty / non-object json", () => {
    expect(parseNpmLsVersions("not json", ["p"])).toEqual({});
    expect(parseNpmLsVersions("", ["p"])).toEqual({});
    expect(parseNpmLsVersions("[]", ["p"])).toEqual({});
    expect(parseNpmLsVersions(JSON.stringify({ other: 1 }), ["p"])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseRegisteredMcpServers — probe parser
// ---------------------------------------------------------------------------

describe("parseRegisteredMcpServers", () => {
  it("unions Claude-style JSON mcpServers names", () => {
    const claude = JSON.stringify({ mcpServers: { track: {}, h2a: {} } });
    const agy = JSON.stringify({ mcpServers: { graphify: {} } });
    expect(parseRegisteredMcpServers({ json: [claude, agy] })).toEqual([
      "graphify",
      "h2a",
      "track",
    ]);
  });

  it("reads codex [mcp_servers.<name>] TOML section headers", () => {
    const toml = [
      "[mcp_servers.track]",
      'command = "node"',
      'args = ["/x.js"]',
      "",
      "[mcp_servers.h2a]",
      'command = "node"',
      'args = ["/y.js"]',
    ].join("\n");
    expect(parseRegisteredMcpServers({ toml })).toEqual(["h2a", "track"]);
  });

  it("unions JSON + TOML and dedups", () => {
    const claude = JSON.stringify({ mcpServers: { track: {} } });
    const toml = "[mcp_servers.track]\n[mcp_servers.codexonly]\n";
    expect(parseRegisteredMcpServers({ json: [claude], toml })).toEqual([
      "codexonly",
      "track",
    ]);
  });

  it("ignores empty / unparseable blobs without throwing", () => {
    expect(parseRegisteredMcpServers({ json: ["", "not json", "{}"] })).toEqual([]);
    expect(parseRegisteredMcpServers({})).toEqual([]);
  });

  it("ignores a JSON body whose mcpServers is not a plain object", () => {
    expect(
      parseRegisteredMcpServers({ json: [JSON.stringify({ mcpServers: [] })] }),
    ).toEqual([]);
  });
});
