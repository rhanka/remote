import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { SessionTarget } from "@sentropic/remote-protocol";

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

/** A named terminal window grouping specific projects (see `remote restore`). */
export type LayoutGroup = { title: string; projects: string[] };

/** Layout for `remote restore`: how recent local sessions map to windows/tabs. */
export type LayoutConfig = {
  /** Only resume sessions touched within this many hours. */
  maxAgeHours: number;
  /** Max tabs per terminal window. */
  maxPerWindow: number;
  /** Number of shared round-robin windows for ungrouped projects. */
  sharedWindows: number;
  /** Per-project: how many recent sessions to resume (default 1). */
  multiSession: Record<string, number>;
  /** Explicit windows; their projects leave the shared pool. */
  groups: LayoutGroup[];
};

export const DEFAULT_LAYOUT: LayoutConfig = {
  maxAgeHours: 48,
  maxPerWindow: 12,
  sharedWindows: 2,
  multiSession: {},
  groups: [],
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

// Resolved lazily so tests can redirect the config home via
// REMOTE_CLI_CONFIG_HOME without clobbering the real ~/.config.
function configHome(): string {
  return process.env.REMOTE_CLI_CONFIG_HOME ?? homedir();
}

export function resolveConfigPath(): string {
  return join(configHome(), ".config", "sentropic", "remote-cli", "config.json");
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
      return config;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`failed to read remote config: ${(error as Error).message}`);
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
      typeof raw.maxAgeHours === "number" ? raw.maxAgeHours : DEFAULT_LAYOUT.maxAgeHours,
    maxPerWindow:
      typeof raw.maxPerWindow === "number" ? raw.maxPerWindow : DEFAULT_LAYOUT.maxPerWindow,
    sharedWindows:
      typeof raw.sharedWindows === "number" ? raw.sharedWindows : DEFAULT_LAYOUT.sharedWindows,
    multiSession:
      raw.multiSession && typeof raw.multiSession === "object"
        ? raw.multiSession
        : DEFAULT_LAYOUT.multiSession,
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
