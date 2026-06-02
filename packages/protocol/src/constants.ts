export const REMOTE_PROTOCOL_VERSION = "0.1.0";
export const REMOTE_CONTROLE_PROTOCOL_VERSION = REMOTE_PROTOCOL_VERSION;
export const REMOTE_SCHEMA_VERSION = "remote.protocol.v1";
export const REMOTE_SCHEMA_BASE_URL =
  "https://schemas.sentropic.dev/remote/0.1";

export const CLI_PROFILES = [
  "shell",
  "codex",
  "opencode",
  "claude",
  "agy",
] as const;

export const SESSION_TARGETS = [
  "docker",
  "k3s",
  "scaleway-kapsule",
  "gke",
] as const;

export const SESSION_LIFECYCLE_STATES = [
  "requested",
  "provisioning",
  "starting",
  "ready",
  "running",
  "waiting-approval",
  "waiting-2fa",
  "degraded",
  "stopping",
  "stopped",
  "failed",
  "expired",
] as const;

export const ACTOR_KINDS = [
  "user",
  "master-agent",
  "session-agent",
  "control-plane",
  "browser-bridge",
  "terminal-transport",
  "system",
] as const;

export const CAPABILITIES = [
  "read-secret",
  "push-git",
  "publish-npm",
  "create-cloud-resource",
  "install-system-package",
  "browser-login",
  "browser-sensitive-action",
  "network-egress",
  "uat-expose",
  "workspace-export",
] as const;

/**
 * Agent→control-plane message types sent over the agent WS connection.
 * No credentials or token fields are ever included in these messages
 * — secret-free by design.
 */
export const AGENT_MESSAGE_TYPES = ["session.announce"] as const;

export const EVENT_TYPES = [
  "session.lifecycle.changed",
  "session.health.reported",
  "session.instruction.received",
  "session.instruction.completed",
  "approval.requested",
  "approval.decided",
  "secret.requested",
  "secret.granted",
  "secret.revoked",
  "terminal.opened",
  "terminal.input",
  "terminal.output",
  "terminal.resized",
  "terminal.exited",
  "browser.started",
  "browser.navigated",
  "browser.user-takeover.requested",
  "browser.user-takeover.changed",
  "browser.2fa.requested",
  "browser.sensitive-action.requested",
  "uat.route.created",
  "uat.route.expired",
  "audit.recorded",
] as const;
