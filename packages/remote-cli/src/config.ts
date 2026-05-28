import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type RemoteCliConfig = {
  defaultRemote?: string;
  token?: string;
};

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
  const { token } = readRemoteConfig();
  writeRemoteConfig(token ? { token } : {});
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
