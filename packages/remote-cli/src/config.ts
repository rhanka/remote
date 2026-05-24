import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "sentropic");
const CONFIG_FILE = join(CONFIG_DIR, "remote-cli", "config.json");

export type RemoteCliConfig = {
  defaultRemote?: string;
};

export function resolveConfigPath(): string {
  return CONFIG_FILE;
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
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const defaultRemote =
        typeof parsed.defaultRemote === "string"
          ? parsed.defaultRemote
          : undefined;
      return defaultRemote ? { defaultRemote } : {};
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`failed to read remote config: ${(error as Error).message}`);
  }
}

export function writeRemoteConfig(config: RemoteCliConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function getDefaultRemote(): string | undefined {
  const config = readRemoteConfig();
  return config.defaultRemote;
}

export function setDefaultRemote(rawUrl: string): string {
  const defaultRemote = normalizeRemoteUrl(rawUrl);
  writeRemoteConfig({ defaultRemote });
  return defaultRemote;
}

export function clearDefaultRemote(): void {
  writeRemoteConfig({});
}
