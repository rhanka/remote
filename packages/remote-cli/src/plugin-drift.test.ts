import { describe, expect, it, vi } from "vitest";

import type { PluginEntry } from "./config.js";
import {
  probePodPluginState,
  pushManifestSidecarVia,
  reconcilePodManifestVia,
  type ManifestPodIo,
  type PodProbeDeps,
} from "./plugin.js";
import {
  canonicalManifestJson,
  diffManifest,
  manifestHash,
  renderManifest,
} from "./plugin-manifest.js";

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

/**
 * Manifest-gate persistence tests (slice-3 regression fix): a converged Pod must
 * NOT re-sync; an absent/mismatched hash must resync ONCE and then converge (the
 * sidecar persists so the next pass is a zero-work no-op). All Pod IO is a
 * stateful fake — these never shell out.
 */

type FakePodIo = ManifestPodIo & {
  syncs: number;
  writes: number;
  stored: { json: string; hash: string };
};

/** A fake Pod whose recorded manifest hash is whatever the last writeSidecar set. */
function fakePodIo(initialHash = ""): FakePodIo {
  const io: FakePodIo = {
    syncs: 0,
    writes: 0,
    stored: { json: "", hash: initialHash },
    readHash: () => io.stored.hash,
    writeSidecar: (json: string, hash: string) => {
      io.writes += 1;
      io.stored = { json, hash };
    },
    runSync: () => {
      io.syncs += 1;
      return "synced";
    },
  };
  return io;
}

describe("manifest gate — converged Pod does NOT re-sync (slice-3 fix)", () => {
  const plugins = [plugin("@sentropic/track", "0.2.0", "track")];
  const manifest = renderManifest(plugins);
  const localHash = manifestHash(manifest);
  const silent = { write: () => true };

  it("matching hash → no resync, no write (zero-work no-op)", () => {
    const io = fakePodIo(localHash);
    const r = reconcilePodManifestVia(io, "session-a", manifest, plugins, silent);
    expect(r.reconciled).toBe(false);
    expect(io.syncs).toBe(0);
    expect(io.writes).toBe(0);
  });

  it("absent hash → resync ONCE, then the NEXT pass converges (no resync)", () => {
    const io = fakePodIo(""); // brand-new / Pod-restart: no sidecar yet
    const first = reconcilePodManifestVia(io, "session-b", manifest, plugins, silent);
    expect(first.reconciled).toBe(true);
    expect(io.syncs).toBe(1);
    expect(io.writes).toBe(1);
    // The sidecar now records the local hash, byte-for-byte the canonical JSON.
    expect(io.stored.hash).toBe(localHash);
    expect(io.stored.json).toBe(canonicalManifestJson(manifest));

    // SECOND pass: the persisted hash matches → no resync, no extra write.
    const second = reconcilePodManifestVia(io, "session-b", manifest, plugins, silent);
    expect(second.reconciled).toBe(false);
    expect(io.syncs).toBe(1); // unchanged — did NOT re-run sync
    expect(io.writes).toBe(1); // unchanged — did NOT re-write
  });

  it("mismatched (stale) hash → resync once, then converges", () => {
    const io = fakePodIo("stale-hash-from-an-older-manifest");
    reconcilePodManifestVia(io, "session-c", manifest, plugins, silent);
    expect(io.syncs).toBe(1);
    expect(io.stored.hash).toBe(localHash);
    // converged
    const again = reconcilePodManifestVia(io, "session-c", manifest, plugins, silent);
    expect(again.reconciled).toBe(false);
    expect(io.syncs).toBe(1);
  });

  it("sidecar still persists when a plugin sync FAILS (so drift can't loop forever)", () => {
    const io = fakePodIo("");
    io.runSync = () => {
      throw new Error("npm i -g blew up");
    };
    const r = reconcilePodManifestVia(io, "session-d", manifest, plugins, silent);
    expect(r.failures).toBe(1);
    // Even with a failed sync, the hash is recorded → next pass won't re-report
    // "manifest absent" forever (the dead-pod guard handles truly-dead Pods).
    expect(io.stored.hash).toBe(localHash);
  });

  it("pushManifestSidecarVia gates exactly like CREDS_HASH_FILE (match → no write)", () => {
    const io = fakePodIo(localHash);
    const r = pushManifestSidecarVia(io, manifest);
    expect(r.wrote).toBe(false);
    expect(io.writes).toBe(0);
    // absent hash → writes once
    const io2 = fakePodIo("");
    expect(pushManifestSidecarVia(io2, manifest).wrote).toBe(true);
    expect(io2.stored.hash).toBe(localHash);
  });
});
