export const REMOTE_CONTROLE_PROTOCOL_VERSION = "0.0.0";

export const CLI_PROFILES = [
  "shell",
  "codex",
  "opencode",
  "claude-code",
  "gemini-cli",
] as const;

export type CliProfile = (typeof CLI_PROFILES)[number];

export const CAPABILITIES = [
  "read-secret",
  "push-git",
  "publish-npm",
  "create-cloud-resource",
  "install-system-package",
  "browser-login",
  "browser-sensitive-action",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type SessionTarget = "k3s" | "scaleway-kapsule" | "gke";

export interface SessionDescriptor {
  readonly id: string;
  readonly profile: CliProfile;
  readonly target: SessionTarget;
  readonly workspacePath: "/workspace";
}
