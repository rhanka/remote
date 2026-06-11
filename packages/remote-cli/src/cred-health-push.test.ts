import { describe, expect, it, vi } from "vitest";

import {
  probeAndPushToolHealth,
  type ToolHealthDeps,
} from "./soft-refresh.js";

/**
 * Unit tests for the additive pod-side 401 probe→push executor. All IO is
 * injected (no kubectl, no ~/ reads), so these never shell out.
 */

function deps(over: Partial<ToolHealthDeps>): ToolHealthDeps {
  return {
    exec: vi.fn(() => ({ status: 0, stdout: "ok" })),
    collect: vi.fn(async () => ({ bundle: {}, bundled: [] })),
    materialize: vi.fn(),
    patchSecretKey: vi.fn(),
    stderr: { write: vi.fn(() => true) },
    ...over,
  };
}

describe("probeAndPushToolHealth — extra trigger, reuses the existing push primitives", () => {
  it("healthy tool (exit 0) → NO push, NO collect, NO patch", async () => {
    const d = deps({ exec: vi.fn(() => ({ status: 0, stdout: "alice" })) });
    const action = await probeAndPushToolHealth("gh", d);
    expect(action.pushed).toBe(false);
    expect(action.health.ok).toBe(true);
    expect(d.collect).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
    expect(d.patchSecretKey).not.toHaveBeenCalled();
  });

  it("npm exit 0 but empty stdout (no user) → treated as 401 → pushes", async () => {
    const d = deps({
      exec: vi.fn(() => ({ status: 0, stdout: "  \n" })),
      collect: vi.fn(async () => ({
        bundle: { ".npmrc": "Yg==" },
        bundled: ["npm"],
      })),
    });
    const action = await probeAndPushToolHealth("npm", d);
    expect(action.health.ok).toBe(false);
    expect(action.pushed).toBe(true);
    expect(d.collect).toHaveBeenCalledWith(["npm"]);
    expect(d.materialize).toHaveBeenCalledWith(".npmrc", "Yg==");
    // Secret key derivation matches the orchestrator (strip leading dot, / → _).
    expect(d.patchSecretKey).toHaveBeenCalledWith("npmrc", "Yg==");
    expect(action.filesPushed).toEqual([".npmrc"]);
    expect(action.secretKeysPatched).toEqual(["npmrc"]);
  });

  it("gh 401 (non-zero) → re-bundles + materializes + patches", async () => {
    const d = deps({
      exec: vi.fn(() => ({ status: 1, stdout: "" })),
      collect: vi.fn(async () => ({
        bundle: { ".config/gh/hosts.yml": "aG9zdHM=" },
        bundled: ["gh"],
      })),
    });
    const action = await probeAndPushToolHealth("gh", d);
    expect(action.pushed).toBe(true);
    expect(d.materialize).toHaveBeenCalledWith(".config/gh/hosts.yml", "aG9zdHM=");
    expect(d.patchSecretKey).toHaveBeenCalledWith("config_gh_hosts.yml", "aG9zdHM=");
  });

  it("401 but NO local creds to push → pushed:false, warns to login", async () => {
    const stderr = { write: vi.fn((_s: string) => true) };
    const d = deps({
      exec: vi.fn(() => ({ status: 1, stdout: "" })),
      collect: vi.fn(async () => ({ bundle: {}, bundled: [] })),
      stderr,
    });
    const action = await probeAndPushToolHealth("docker", d);
    expect(action.pushed).toBe(false);
    expect(action.filesPushed).toEqual([]);
    expect(stderr.write).toHaveBeenCalled();
    const out = stderr.write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("docker login");
  });

  it("never logs a secret VALUE — only tool name + reason", async () => {
    const stderr = { write: vi.fn((_s: string) => true) };
    const d = deps({
      exec: vi.fn(() => ({ status: 1, stdout: "" })),
      collect: vi.fn(async () => ({
        bundle: { ".npmrc": "U0VDUkVUVE9LRU4=" },
        bundled: ["npm"],
      })),
      stderr,
    });
    await probeAndPushToolHealth("npm", d);
    const out = stderr.write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("U0VDUkVUVE9LRU4=");
    expect(out).toContain("npm");
  });
});
