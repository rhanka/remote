import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { SessionTarget } from "./protocol-local.js";

/**
 * How the CLI reaches the control-plane when the configured URL is not directly
 * routable (no public ingress). When set, the CLI brings this tunnel up on
 * demand (kubectl port-forward) at connect/attach/ls/migrate time — so the user
 * never manages a port-forward by hand.
 */
export type TunnelConfig = {
  /** kubeconfig path (a leading ~ is expanded); defaults to kubectl's default. */
  kubeconfig?: string;
  namespace: string;
  service: string;
  localPort: number;
  remotePort: number;
};

/**
 * A named terminal window in `remote restore`. A LOCAL group lists `projects`
 * (resumed as local tmux sessions). A REMOTE group (`remote: true`) has its tabs
 * filled from the SCW control-plane's live sessions (attached via `--exec`).
 */
export type LayoutGroup = {
  title: string;
  projects?: string[];
  remote?: boolean;
};

/** Layout for `remote restore`: how recent local sessions map to windows/tabs. */
export type LayoutConfig = {
  /** Only resume sessions touched within this many hours. */
  maxAgeHours: number;
  /** Max tabs per terminal window. */
  maxPerWindow: number;
  /** Number of shared round-robin windows for ungrouped projects. */
  sharedWindows: number;
  /** Per-project: how many recent sessions to resume (default `multiSessionDefault`). */
  multiSession: Record<string, number>;
  /**
   * Fallback per-project cap when a project has no `multiSession` override.
   * 1 = the old behaviour (one tab per project). <= 0 = no limit (resume EVERY
   * live session of the project) — useful for a full-fleet `remote restore`.
   */
  multiSessionDefault: number;
  /** Explicit windows; their projects leave the shared pool. */
  groups: LayoutGroup[];
};

export const DEFAULT_LAYOUT: LayoutConfig = {
  maxAgeHours: 48,
  maxPerWindow: 12,
  sharedWindows: 2,
  multiSession: {},
  multiSessionDefault: 1,
  groups: [],
};

/**
 * One MCP server provided by an installed plugin package.
 *
 * `command` is always "node" and `args` the script's realpath: some packages
 * (track@0.2.0) have an entrypoint guard that breaks when the script is run
 * through the npm-global bin symlink, so the bare bin name must never be
 * registered — see plugin.ts.
 */
export type PluginMcp = {
  name: string;
  command: string;
  args: string[];
  /**
   * Bin script path relative to the package dir (e.g. "dist/mcp.js") — used by
   * `remote plugin sync` to recompute the realpath inside remote Pods, where
   * the npm global root differs from the local one.
   */
  scriptRel?: string;
};

/**
 * How a plugin is installed in a session Pod. Default (omitted) = `npm`
 * (`npm i -g <pkg>@<version>`). `curl` pipes an installer script
 * (`curl -fsSL <spec> | bash`) — e.g. a Go binary's install.sh. `script` runs
 * an arbitrary shell line (from the user's own config). Lets non-npm tools be
 * propagated the same way.
 */
export type PluginInstall = {
  method: "npm" | "curl" | "script";
  /** curl: the installer URL; script: the shell command. Unused for npm. */
  spec?: string;
};

/** A plugin propagated to sessions (npm pkg, or curl/script installer) + MCP(s). */
export type PluginEntry = {
  pkg: string;
  version: string;
  mcp: PluginMcp[];
  /** Install method; omitted ⇒ npm (pkg@version). */
  install?: PluginInstall;
};

/**
 * h2a launcher contract (opt-in): when a local session starts via `remote run`,
 * also start `h2a mcp-serve` in a side tmux window so the agent is
 * reachable/wakeable by the h2a file-based agent network (~/h2a-workspace/.h2a).
 */
export type H2aConfig = {
  /** Start the h2a window on every `remote run` (default false; `--h2a` forces one run). */
  enabled?: boolean;
  /** Command line run in the dedicated "h2a" window (default: DEFAULT_H2A_COMMAND). */
  command?: string;
};

/** Default h2a side-window command (a2a-cli launcher contract). */
export const DEFAULT_H2A_COMMAND =
  "h2a mcp-serve --auto-open --auto-upgrade --wake local-tmux";

/**
 * Local LLM gateway runtime policy. The credential/account material itself
 * lives in ~/.sentropic/llm-mesh.json; this config only records whether remote
 * should reactivate that gateway for local sessions and restore.
 */
export type LlmMeshRuntimeConfig = {
  /** Auto-inject/reactivate llm-mesh for local Claude sessions. Default false. */
  enabled?: boolean;
};

export type TmuxProfileConfig = {
  /** Remote-managed tmux profile name applied to local sessions. Default: remote. */
  profile?: string;
};

export type RemoteCliConfig = {
  defaultRemote?: string;
  token?: string;
  tunnel?: TunnelConfig;
  /** Session target label (where the workload runs). Defaults to scaleway-kapsule. */
  defaultTarget?: string;
  /** Tool CLIs whose auth to bundle into deported sessions by default (scw, gh, …). */
  defaultTools?: string[];
  /** `remote restore` layout (windows/tabs from recent local sessions). */
  layout?: Partial<LayoutConfig>;
  /** Plugins installed via `remote plugin add` (synced to Pods via `remote plugin sync`). */
  plugins?: PluginEntry[];
  /** h2a launcher contract for `remote run` (opt-in side window). */
  h2a?: H2aConfig;
  /** Local LLM gateway runtime policy (credentials remain in ~/.sentropic). */
  llmMesh?: LlmMeshRuntimeConfig;
  /** Remote-managed tmux config profile for local tmux sessions. */
  tmux?: TmuxProfileConfig;
  /** P4 — default concurrency cap for delegated jobs (local AND remote). */
  maxConcurrent?: number;
};

/** Default session target when none is configured/passed. */
export const DEFAULT_SESSION_TARGET: SessionTarget = "scaleway-kapsule";

function parseTunnel(raw: unknown): TunnelConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.namespace !== "string" ||
    typeof t.service !== "string" ||
    typeof t.localPort !== "number" ||
    typeof t.remotePort !== "number"
  ) {
    return undefined;
  }
  const tunnel: TunnelConfig = {
    namespace: t.namespace,
    service: t.service,
    localPort: t.localPort,
    remotePort: t.remotePort,
  };
  if (typeof t.kubeconfig === "string") tunnel.kubeconfig = t.kubeconfig;
  return tunnel;
}

function parseH2a(raw: unknown): H2aConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Record<string, unknown>;
  const h2a: H2aConfig = {};
  if (typeof h.enabled === "boolean") h2a.enabled = h.enabled;
  if (typeof h.command === "string") h2a.command = h.command;
  return Object.keys(h2a).length > 0 ? h2a : undefined;
}

function parseLlmMeshRuntime(raw: unknown): LlmMeshRuntimeConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const llmMesh: LlmMeshRuntimeConfig = {};
  if (typeof r.enabled === "boolean") llmMesh.enabled = r.enabled;
  return Object.keys(llmMesh).length > 0 ? llmMesh : undefined;
}

function parseTmuxProfile(raw: unknown): TmuxProfileConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const tmux: TmuxProfileConfig = {};
  if (typeof r.profile === "string" && r.profile.trim()) {
    tmux.profile = r.profile.trim();
  }
  return Object.keys(tmux).length > 0 ? tmux : undefined;
}

function parsePluginMcp(raw: unknown): PluginMcp | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.name !== "string" ||
    typeof m.command !== "string" ||
    !Array.isArray(m.args) ||
    !m.args.every((a: unknown) => typeof a === "string")
  ) {
    return undefined;
  }
  const mcp: PluginMcp = {
    name: m.name,
    command: m.command,
    args: m.args as string[],
  };
  if (typeof m.scriptRel === "string") mcp.scriptRel = m.scriptRel;
  return mcp;
}

function parsePlugins(raw: unknown): PluginEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const plugins: PluginEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (
      typeof p.pkg !== "string" ||
      typeof p.version !== "string" ||
      !Array.isArray(p.mcp)
    ) {
      continue;
    }
    const mcp = p.mcp
      .map(parsePluginMcp)
      .filter((m): m is PluginMcp => m !== undefined);
    const entry: PluginEntry = { pkg: p.pkg, version: p.version, mcp };
    const install = parsePluginInstall(p.install);
    if (install) entry.install = install;
    plugins.push(entry);
  }
  return plugins;
}

function parsePluginInstall(raw: unknown): PluginInstall | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as Record<string, unknown>;
  if (i.method !== "npm" && i.method !== "curl" && i.method !== "script") {
    return undefined;
  }
  const install: PluginInstall = { method: i.method };
  if (typeof i.spec === "string") install.spec = i.spec;
  return install;
}

// Resolved lazily so tests can redirect the config home via
// REMOTE_CLI_CONFIG_HOME without clobbering the real ~/.config.
function configHome(): string {
  return process.env.REMOTE_CLI_CONFIG_HOME ?? homedir();
}

export function resolveConfigPath(): string {
  return join(
    configHome(),
    ".config",
    "sentropic",
    "remote-cli",
    "config.json",
  );
}

export function normalizeRemoteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("Remote URL cannot be empty.");
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported remote URL protocol "${parsed.protocol}". Use http:// or https://.`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

export function readRemoteConfig(): RemoteCliConfig {
  try {
    const raw = readFileSync(resolveConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const config: RemoteCliConfig = {};
      if (typeof parsed.defaultRemote === "string")
        config.defaultRemote = parsed.defaultRemote;
      if (typeof parsed.token === "string") config.token = parsed.token;
      if (typeof parsed.defaultTarget === "string")
        config.defaultTarget = parsed.defaultTarget;
      if (
        Array.isArray(parsed.defaultTools) &&
        parsed.defaultTools.every((t: unknown) => typeof t === "string")
      ) {
        config.defaultTools = parsed.defaultTools;
      }
      const tunnel = parseTunnel(parsed.tunnel);
      if (tunnel) config.tunnel = tunnel;
      if (parsed.layout && typeof parsed.layout === "object")
        config.layout = parsed.layout as Partial<LayoutConfig>;
      const plugins = parsePlugins(parsed.plugins);
      if (plugins) config.plugins = plugins;
      const h2a = parseH2a(parsed.h2a);
      if (h2a) config.h2a = h2a;
      const llmMesh = parseLlmMeshRuntime(parsed.llmMesh);
      if (llmMesh) config.llmMesh = llmMesh;
      const tmux = parseTmuxProfile(parsed.tmux);
      if (tmux) config.tmux = tmux;
      if (
        typeof parsed.maxConcurrent === "number" &&
        Number.isFinite(parsed.maxConcurrent) &&
        parsed.maxConcurrent > 0
      ) {
        config.maxConcurrent = Math.trunc(parsed.maxConcurrent);
      }
      return config;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `failed to read remote config: ${(error as Error).message}`,
    );
  }
}

export function writeRemoteConfig(config: RemoteCliConfig): void {
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

export function getDefaultRemote(): string | undefined {
  const config = readRemoteConfig();
  return config.defaultRemote;
}

export function setDefaultRemote(rawUrl: string): string {
  const defaultRemote = normalizeRemoteUrl(rawUrl);
  writeRemoteConfig({ ...readRemoteConfig(), defaultRemote });
  return defaultRemote;
}

export function clearDefaultRemote(): void {
  const { defaultRemote: _drop, ...rest } = readRemoteConfig();
  writeRemoteConfig(rest);
}

export function getDefaultTarget(): SessionTarget {
  const configured = readRemoteConfig().defaultTarget;
  return (configured as SessionTarget | undefined) ?? DEFAULT_SESSION_TARGET;
}

export function setDefaultTarget(value: string): void {
  writeRemoteConfig({ ...readRemoteConfig(), defaultTarget: value });
}

export function getDefaultTools(): string[] {
  return readRemoteConfig().defaultTools ?? [];
}

export function setDefaultTools(tools: string[]): void {
  writeRemoteConfig({ ...readRemoteConfig(), defaultTools: tools });
}

/** Plugins installed via `remote plugin add` (mirrors getDefaultTools). */
export function getPlugins(): PluginEntry[] {
  return readRemoteConfig().plugins ?? [];
}

export function setPlugins(plugins: PluginEntry[]): void {
  writeRemoteConfig({ ...readRemoteConfig(), plugins });
}

/** h2a config merged with defaults (enabled=false, default mcp-serve command). */
export function getH2aConfig(): Required<H2aConfig> {
  const raw = readRemoteConfig().h2a ?? {};
  return {
    enabled: raw.enabled ?? false,
    command: raw.command ?? DEFAULT_H2A_COMMAND,
  };
}

export function setH2aConfig(h2a: H2aConfig): void {
  writeRemoteConfig({ ...readRemoteConfig(), h2a });
}

export function getLlmMeshRuntimeConfig(): Required<LlmMeshRuntimeConfig> {
  const raw = readRemoteConfig().llmMesh ?? {};
  return {
    enabled: raw.enabled ?? false,
  };
}

export function setLlmMeshRuntimeConfig(llmMesh: LlmMeshRuntimeConfig): void {
  writeRemoteConfig({ ...readRemoteConfig(), llmMesh });
}

export function getTmuxProfileConfig(): Required<TmuxProfileConfig> {
  const raw = readRemoteConfig().tmux ?? {};
  return { profile: raw.profile ?? "remote" };
}

export function setTmuxProfileConfig(tmux: TmuxProfileConfig): void {
  writeRemoteConfig({ ...readRemoteConfig(), tmux });
}

/**
 * P4 — the configured default concurrency cap for delegated jobs, or undefined
 * when unset (the caller falls back to DEFAULT_MAX_CONCURRENT). The env override
 * `REMOTE_MAX_CONCURRENT` wins so a conductor window can be tuned without writing
 * config.
 */
export function getMaxConcurrent(): number | undefined {
  const env = process.env.REMOTE_MAX_CONCURRENT;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return readRemoteConfig().maxConcurrent;
}

export function setMaxConcurrent(value: number): void {
  writeRemoteConfig({ ...readRemoteConfig(), maxConcurrent: value });
}

/** Generous default age (hours) after which a stuck `running` job is swept → failed. */
export const DEFAULT_JOB_MAX_AGE_HOURS = 24;

/**
 * Max age (hours) a delegated job may stay `running`/`awaiting-decision` before
 * the reconciler sweeps it to `failed` (M2 — convergence: a job whose hook +
 * liveness signal were both lost would otherwise occupy a slot forever).
 * `REMOTE_JOB_MAX_AGE_HOURS` overrides; default is generous (24h) so a genuinely
 * long-running interactive job is never killed prematurely.
 */
export function getJobMaxAgeHours(): number {
  const env = process.env.REMOTE_JOB_MAX_AGE_HOURS;
  if (env !== undefined) {
    const n = Number.parseFloat(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_JOB_MAX_AGE_HOURS;
}

export function getTunnel(): TunnelConfig | undefined {
  return readRemoteConfig().tunnel;
}

export function setTunnel(tunnel: TunnelConfig): void {
  writeRemoteConfig({ ...readRemoteConfig(), tunnel });
}

export function clearTunnel(): void {
  const { tunnel: _drop, ...rest } = readRemoteConfig();
  writeRemoteConfig(rest);
}

/** Layout config merged with defaults (used by `remote restore`). */
export function getLayoutConfig(): LayoutConfig {
  const raw = readRemoteConfig().layout ?? {};
  return {
    maxAgeHours:
      typeof raw.maxAgeHours === "number"
        ? raw.maxAgeHours
        : DEFAULT_LAYOUT.maxAgeHours,
    maxPerWindow:
      typeof raw.maxPerWindow === "number"
        ? raw.maxPerWindow
        : DEFAULT_LAYOUT.maxPerWindow,
    sharedWindows:
      typeof raw.sharedWindows === "number"
        ? raw.sharedWindows
        : DEFAULT_LAYOUT.sharedWindows,
    multiSession:
      raw.multiSession && typeof raw.multiSession === "object"
        ? raw.multiSession
        : DEFAULT_LAYOUT.multiSession,
    multiSessionDefault:
      typeof raw.multiSessionDefault === "number"
        ? raw.multiSessionDefault
        : DEFAULT_LAYOUT.multiSessionDefault,
    groups: Array.isArray(raw.groups) ? raw.groups : DEFAULT_LAYOUT.groups,
  };
}

export function setLayoutConfig(layout: Partial<LayoutConfig>): void {
  writeRemoteConfig({ ...readRemoteConfig(), layout });
}

export function getToken(): string | undefined {
  return process.env.REMOTE_TOKEN ?? readRemoteConfig().token;
}

export function setToken(value: string): void {
  writeRemoteConfig({ ...readRemoteConfig(), token: value });
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
