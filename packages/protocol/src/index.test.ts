import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CLI_PROFILES,
  REMOTE_CONTROLE_PROTOCOL_VERSION,
  type SessionDescriptor,
} from "./index.js";

describe("protocol constants", () => {
  it("declares the MVP CLI profiles", () => {
    expect(CLI_PROFILES).toEqual([
      "shell",
      "codex",
      "opencode",
      "claude-code",
      "gemini-cli",
    ]);
  });

  it("declares capability-based approval names", () => {
    expect(CAPABILITIES).toContain("read-secret");
    expect(CAPABILITIES).toContain("browser-sensitive-action");
  });

  it("uses an explicit protocol version", () => {
    expect(REMOTE_CONTROLE_PROTOCOL_VERSION).toBe("0.0.0");
  });

  it("models a k3s session workspace", () => {
    const descriptor: SessionDescriptor = {
      id: "session-001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/workspace",
    };

    expect(descriptor.workspacePath).toBe("/workspace");
  });
});
