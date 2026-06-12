/**
 * Plugin/MCP DESIRED-STATE manifest + drift diff (remote supervise slice 3) —
 * ADDITIVE, PURE. No IO, no clock. The watch loop / `plugin sync --check` call
 * these to RENDER the desired set, HASH it (to gate a sidecar push exactly like
 * CREDS_HASH_FILE), and DIFF it against what a Pod actually has installed.
 *
 * Why a manifest at all: MCP servers + plugin CLIs (track, h2a, harness,
 * graphify, skills) baked/installed into Pods drift away from the LOCAL
 * source-of-truth — a Pod restart loses globally-installed plugins, a re-pin
 * bumps the local version, and nothing today DETECTS the gap (`plugin ls`
 * prints `REMOTE ?`). The manifest is the canonical "what every Pod SHOULD have"
 * record; its sha256 is the cheap drift signal (one `kubectl exec cat`), and the
 * diff is the per-item report.
 *
 * BIGGEST REMAINING DRIFT SOURCE (DEFERRED — converge-on-session-start): a
 * freshly (re)created Pod boots with NO plugins until the next `plugin sync` /
 * watch pass reconciles it, so its CLI starts WITHOUT track/h2a/etc. Closing
 * that needs the session-agent / orchestrator to run the sync BEFORE the CLI
 * launches — a session-agent change that is OUT OF SCOPE this slice. It hooks in
 * at the session-agent startup path (packages/session-agent, the pane that
 * launches `<cli>`): before exec'ing the CLI, run the equivalent of
 * `buildPodSyncScript` for each desired plugin + write this manifest sidecar.
 * TODO(slice 4): wire converge-on-session-start there; until then the watch-pass
 * reconcile (compareManifestHash → re-run buildPodSyncScript) is the safety net.
 *
 * NOTHING here is a NEW push path: `plugin sync` (no --check) still converges via
 * the EXISTING buildPodSyncScript, untouched. This module only adds a manifest
 * artifact + a read-only drift report.
 */

import { createHash } from "node:crypto";

import type { PluginEntry } from "./config.js";

// ---------------------------------------------------------------------------
// Desired-state manifest (canonical, deterministic)
// ---------------------------------------------------------------------------

/** One plugin package the Pods should carry (pkg + pinned version). */
export type ManifestPlugin = { readonly pkg: string; readonly version: string };

/** One MCP server the Pods should have registered (name + bin/script ref). */
export type ManifestMcp = { readonly name: string; readonly bin: string };

/**
 * The desired-state manifest: the canonical set of plugins + MCP servers (+
 * optional tracked skills) every live Pod should converge to. Field order /
 * array order are NORMALIZED by `renderManifest` so the JSON — and therefore the
 * hash — is independent of config key order.
 */
export type PluginManifest = {
  readonly plugins: ReadonlyArray<ManifestPlugin>;
  readonly mcp: ReadonlyArray<ManifestMcp>;
  /** Tracked skills, if any are recorded as desired state (none today; reserved). */
  readonly skills?: ReadonlyArray<string>;
};

/**
 * The MCP "bin" reference recorded in the manifest. We use the package-relative
 * script path (`scriptRel`, e.g. "dist/mcp.js") when known — it is the stable,
 * Pod-portable identity (the realpath differs per npm-global root). When a
 * plugin entry has no scriptRel recorded we fall back to the server name so the
 * manifest still names the server (a plain presence check downstream).
 */
function manifestMcpBin(mcp: { name: string; scriptRel?: string }): string {
  return mcp.scriptRel ?? mcp.name;
}

/**
 * Render the CANONICAL desired-state manifest from the configured plugins.
 * Deterministic: plugins sorted by pkg, MCP servers sorted by name, skills
 * sorted — so two configs that differ only in array/key ORDER render the SAME
 * manifest (and hash). PURE. `skills` is emitted only when a non-empty tracked
 * list is passed (none is tracked in config today — reserved for slice 4).
 */
export function renderManifest(
  plugins: ReadonlyArray<PluginEntry>,
  skills: ReadonlyArray<string> = [],
): PluginManifest {
  const manifestPlugins: ManifestPlugin[] = [...plugins]
    .map((p) => ({ pkg: p.pkg, version: p.version }))
    .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));

  const mcp: ManifestMcp[] = [];
  for (const p of plugins) {
    for (const m of p.mcp) {
      mcp.push({ name: m.name, bin: manifestMcpBin(m) });
    }
  }
  mcp.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const manifest: PluginManifest = { plugins: manifestPlugins, mcp };
  const uniqueSkills = [...new Set(skills)].sort();
  if (uniqueSkills.length > 0) {
    return { ...manifest, skills: uniqueSkills };
  }
  return manifest;
}

/**
 * The CANONICAL JSON string of a manifest: keys in a FIXED order (plugins, mcp,
 * skills) and every object's keys emitted in a fixed order, so the serialization
 * is byte-stable regardless of how the manifest object was built. This is what
 * gets written to `~/.remote-manifest.json` in the Pod AND what is hashed.
 */
export function canonicalManifestJson(manifest: PluginManifest): string {
  const canonical: Record<string, unknown> = {
    plugins: manifest.plugins.map((p) => ({ pkg: p.pkg, version: p.version })),
    mcp: manifest.mcp.map((m) => ({ name: m.name, bin: m.bin })),
  };
  if (manifest.skills && manifest.skills.length > 0) {
    canonical.skills = [...manifest.skills];
  }
  return JSON.stringify(canonical);
}

/**
 * sha256 (hex) of the canonical manifest JSON — the cheap drift signal. Same
 * input → same hash; key-order / array-order independent (renderManifest
 * normalizes order, canonicalManifestJson fixes serialization). Mirrors
 * `hashAuthBundle` in soft-refresh.ts: the Pod records this hex in
 * `~/.remote-manifest.sha256`, and a pass compares local vs Pod to gate the
 * sidecar push + trigger a reconcile.
 */
export function manifestHash(manifest: PluginManifest): string {
  return createHash("sha256").update(canonicalManifestJson(manifest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Drift diff (pure planner — `plugin sync --check`)
// ---------------------------------------------------------------------------

/**
 * What a Pod actually has installed, as probed by the thin pod-state reader:
 *  - `pluginVersions`: pkg -> installed version (from `npm ls -g --json`); a pkg
 *    absent from the map means it is NOT installed globally in the Pod.
 *  - `mcpRegistered`: the set of MCP server NAMES the Pod has registered (read
 *    from the claude/codex/agy config files the existing sync writes).
 */
export type PodPluginState = {
  readonly pluginVersions: Readonly<Record<string, string>>;
  readonly mcpRegistered: ReadonlyArray<string>;
};

/** Drift status for one desired item in one Pod. */
export type DriftStatus =
  | "ok"
  | "version-drift"
  | "missing"
  | "mcp-unregistered";

/** One row of the drift report: a desired item's status in a Pod. */
export type DriftRow = {
  readonly pod: string;
  /** "plugin:<pkg>" or "mcp:<name>". */
  readonly item: string;
  readonly status: DriftStatus;
  /** Human detail (e.g. "local@1.2.0 vs pod@1.1.0"); empty for ok. */
  readonly detail: string;
};

/**
 * DIFF the desired manifest against one Pod's actual state. PURE. One row per
 * desired plugin + one per desired MCP server:
 *  - plugin MISSING       → pkg not installed globally in the Pod.
 *  - plugin VERSION-DRIFT  → installed but at a different version than desired.
 *  - plugin OK             → installed at the desired version.
 *  - mcp MCP-UNREGISTERED  → desired MCP name not in the Pod's registered set.
 *  - mcp OK                → registered.
 * Rows preserve the manifest's (already-canonical) order, plugins before mcp.
 */
export function diffManifest(
  manifest: PluginManifest,
  pod: string,
  state: PodPluginState,
): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const p of manifest.plugins) {
    const installed = state.pluginVersions[p.pkg];
    if (installed === undefined) {
      rows.push({
        pod,
        item: `plugin:${p.pkg}`,
        status: "missing",
        detail: `not installed (desired ${p.version})`,
      });
    } else if (installed !== p.version) {
      rows.push({
        pod,
        item: `plugin:${p.pkg}`,
        status: "version-drift",
        detail: `local@${p.version} vs pod@${installed}`,
      });
    } else {
      rows.push({ pod, item: `plugin:${p.pkg}`, status: "ok", detail: "" });
    }
  }
  const registered = new Set(state.mcpRegistered);
  for (const m of manifest.mcp) {
    if (registered.has(m.name)) {
      rows.push({ pod, item: `mcp:${m.name}`, status: "ok", detail: "" });
    } else {
      rows.push({
        pod,
        item: `mcp:${m.name}`,
        status: "mcp-unregistered",
        detail: "not registered in the pod's MCP config",
      });
    }
  }
  return rows;
}

/** A row is drift when its status is anything other than `ok`. */
export function isDrift(row: DriftRow): boolean {
  return row.status !== "ok";
}

/**
 * The process exit code for a `--check` run: 1 when ANY row across all Pods is
 * drift, else 0. PURE — the command stays a thin printer around this. An empty
 * report (no Pods / no desired items) is NOT drift → exit 0.
 */
export function checkExitCode(rows: ReadonlyArray<DriftRow>): number {
  return rows.some(isDrift) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Pod-state probe PARSERS (pure — the executors that shell out stay thin).
// ---------------------------------------------------------------------------

/**
 * Parse `npm ls -g --json` output into pkg -> installed version, keeping ONLY
 * the packages we care about (`wanted`). npm's JSON is
 * `{ dependencies: { "<pkg>": { version, ... }, ... } }`; a missing/!
 * unparseable blob yields an empty map (treated downstream as "nothing
 * installed" → all desired plugins report missing, which is the safe drift
 * signal). PURE, exported for tests. A pkg present but without a string version
 * is skipped (can't assert a version → reported missing, never a false "ok").
 */
export function parseNpmLsVersions(
  json: string,
  wanted: ReadonlyArray<string>,
): Record<string, string> {
  const want = new Set(wanted);
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const deps = (parsed as Record<string, unknown>).dependencies;
  if (!deps || typeof deps !== "object") return out;
  for (const [pkg, info] of Object.entries(deps as Record<string, unknown>)) {
    if (!want.has(pkg)) continue;
    if (info && typeof info === "object") {
      const v = (info as Record<string, unknown>).version;
      if (typeof v === "string") out[pkg] = v;
    }
  }
  return out;
}

/**
 * Parse the set of registered MCP server NAMES from the Pod's MCP config blobs.
 * The existing sync writes either a Claude-style JSON (`{"mcpServers": {...}}` —
 * ~/.claude.json and agy's mcp_config.json) or codex TOML
 * (`[mcp_servers.<name>]` sections). We read whatever blobs are present and
 * union their server names. PURE, exported for tests. A blob that is empty /
 * unparseable contributes nothing (never throws — an unreadable config is just
 * "no servers from there", surfacing as mcp-unregistered, the safe drift call).
 */
export function parseRegisteredMcpServers(blobs: {
  /** ~/.claude.json and/or agy mcp_config.json bodies (Claude-style JSON). */
  readonly json?: ReadonlyArray<string>;
  /** ~/.codex/config.toml body. */
  readonly toml?: string;
}): string[] {
  const names = new Set<string>();
  for (const body of blobs.json ?? []) {
    if (!body || !body.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const name of Object.keys(servers as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  if (blobs.toml) {
    // `[mcp_servers.<name>]` section headers — name is SAFE_NAME ([A-Za-z0-9_-]).
    const re = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blobs.toml)) !== null) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}
