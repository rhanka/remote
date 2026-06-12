import { describe, expect, it, vi } from "vitest";

import type { PluginEntry } from "./config.js";
import { probePodPluginState, type PodProbeDeps } from "./plugin.js";
import { diffManifest, renderManifest } from "./plugin-manifest.js";

/**
 * Executor-seam tests for the slice-3 drift probe. The IO (npm ls / config
 * reads) is injected via `PodProbeDeps`, so these never shell out: they assert
 * the probe wires the pure parsers into a `PodPluginState` correctly, and that
 * the resulting state diffs as expected end-to-end.
 */

function plugin(pkg: string, version: string, mcpName: string): PluginEntry {
  return {
    pkg,
    version,
    mcp: [{ name: mcpName, command: "node", args: ["/x.js"], scriptRel: "dist/mcp.js" }],
  };
}

describe("probePodPluginState — injected IO, no shelling out", () => {
  it("parses npm ls + MCP config blobs into a PodPluginState", () => {
    const deps: PodProbeDeps = {
      npmLs: vi.fn(() =>
        JSON.stringify({
          dependencies: {
            "@sentropic/track": { version: "0.2.0" },
            h2a: { version: "1.0.0" },
          },
        }),
      ),
      readMcpConfigs: vi.fn(() => ({
        json: [JSON.stringify({ mcpServers: { track: {}, h2a: {} } })],
        toml: "",
      })),
    };
    const state = probePodPluginState(["@sentropic/track", "h2a"], deps);
    expect(state.pluginVersions).toEqual({
      "@sentropic/track": "0.2.0",
      h2a: "1.0.0",
    });
    expect(state.mcpRegistered).toEqual(["h2a", "track"]);
    expect(deps.npmLs).toHaveBeenCalledWith(["@sentropic/track", "h2a"]);
  });

  it("end-to-end: a Pod missing a plugin + an unregistered MCP diffs as drift", () => {
    const manifest = renderManifest([
      plugin("@sentropic/track", "0.2.0", "track"),
      plugin("h2a", "1.0.0", "h2a"),
    ]);
    const deps: PodProbeDeps = {
      // only track installed, at an OLD version; h2a absent
      npmLs: () =>
        JSON.stringify({ dependencies: { "@sentropic/track": { version: "0.1.0" } } }),
      // only track's MCP registered (codex TOML); h2a unregistered
      readMcpConfigs: () => ({ json: [], toml: "[mcp_servers.track]\n" }),
    };
    const state = probePodPluginState(
      manifest.plugins.map((p) => p.pkg),
      deps,
    );
    const rows = diffManifest(manifest, "session-z", state);
    const byItem = Object.fromEntries(rows.map((r) => [r.item, r.status]));
    expect(byItem["plugin:@sentropic/track"]).toBe("version-drift");
    expect(byItem["plugin:h2a"]).toBe("missing");
    expect(byItem["mcp:track"]).toBe("ok");
    expect(byItem["mcp:h2a"]).toBe("mcp-unregistered");
  });

  it("config-read returning empty blobs ⇒ every desired MCP is unregistered", () => {
    const manifest = renderManifest([plugin("p", "1.0.0", "pmcp")]);
    const deps: PodProbeDeps = {
      npmLs: () => JSON.stringify({ dependencies: { p: { version: "1.0.0" } } }),
      readMcpConfigs: () => ({ json: ["", ""], toml: "" }),
    };
    const state = probePodPluginState(["p"], deps);
    const rows = diffManifest(manifest, "pod", state);
    expect(rows.find((r) => r.item === "mcp:pmcp")?.status).toBe(
      "mcp-unregistered",
    );
    expect(rows.find((r) => r.item === "plugin:p")?.status).toBe("ok");
  });
});
