export const REMOTE_PROTOCOL_VERSION = "0.1.0";
export const REMOTE_SCHEMA_VERSION = "remote.protocol.v1";
export const CLI_PROFILES = [
  "shell",
  "codex",
  "opencode",
  "claude",
  "agy",
  "gemini",
  "mistral",
] as const;

export type CliProfile = (typeof CLI_PROFILES)[number];
export type SessionTarget = "docker" | "k3s" | "scaleway-kapsule" | "gke";
export type UatExposurePolicy =
  | "operator-only"
  | "session-private"
  | "public-expiring";
export type RemoteEventEnvelope = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  sequence: number;
  type: string;
  occurredAt: string;
  correlationId: string;
  actor: Record<string, unknown>;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type TerminalOpened = {
  terminalId: string;
  shell: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};
