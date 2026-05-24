import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  CAPABILITIES,
  CLI_PROFILES,
  EVENT_TYPES,
  REMOTE_CONTROLE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_BASE_URL,
  REMOTE_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  SESSION_TARGETS,
} from "./index.js";

describe("protocol constants", () => {
  it("declares the protocol version and compatibility version", () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe("0.1.0");
    expect(REMOTE_CONTROLE_PROTOCOL_VERSION).toBe(REMOTE_PROTOCOL_VERSION);
    expect(REMOTE_SCHEMA_VERSION).toBe("remote.protocol.v1");
    expect(REMOTE_SCHEMA_BASE_URL).toBe(
      "https://schemas.sentropic.dev/remote/0.1",
    );
  });

  it("declares the MVP CLI profiles", () => {
    expect(CLI_PROFILES).toEqual([
      "shell",
      "codex",
      "opencode",
      "claude",
      "agy",
    ]);
  });

  it("declares target, lifecycle, actor, capability, and event names", () => {
    expect(SESSION_TARGETS).toEqual(["k3s", "scaleway-kapsule", "gke"]);
    expect(SESSION_LIFECYCLE_STATES).toEqual([
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
    ]);
    expect(ACTOR_KINDS).toEqual([
      "user",
      "master-agent",
      "session-agent",
      "control-plane",
      "browser-bridge",
      "terminal-transport",
      "system",
    ]);
    expect(CAPABILITIES).toEqual([
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
    ]);
    expect(EVENT_TYPES).toEqual([
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
    ]);
  });
});
