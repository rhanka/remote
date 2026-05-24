import { describe, expect, it } from "vitest";

import {
  AuthRefreshError,
  ensureProfileAuthFresh,
  type RunCommand,
} from "./auth-refresh.js";

describe("ensureProfileAuthFresh", () => {
  it("runs codex login status before bundling codex auth", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const runCommand: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "Logged in", stderr: "" };
    };

    const result = await ensureProfileAuthFresh("codex", { runCommand });

    expect(result).toEqual({ checked: true, command: "codex login status" });
    expect(calls).toEqual([{ command: "codex", args: ["login", "status"] }]);
  });

  it("runs claude auth status before bundling claude credentials", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const runCommand: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '{"loggedIn":true}', stderr: "" };
    };

    const result = await ensureProfileAuthFresh("claude", { runCommand });

    expect(result).toEqual({ checked: true, command: "claude auth status" });
    expect(calls).toEqual([{ command: "claude", args: ["auth", "status"] }]);
  });

  it("returns no-status-command for profiles without a noninteractive auth status", async () => {
    const result = await ensureProfileAuthFresh("agy", {
      async runCommand() {
        throw new Error("should not be called");
      },
    });

    expect(result).toEqual({
      checked: false,
      reason: "no-status-command",
    });
  });

  it("throws an actionable refresh error when the status command fails", async () => {
    const runCommand: RunCommand = async () => ({
      status: 1,
      stdout: "",
      stderr: "not logged in",
    });

    await expect(
      ensureProfileAuthFresh("codex", { runCommand }),
    ).rejects.toMatchObject({
      name: "AuthRefreshError",
      profile: "codex",
      refreshHint: "codex login",
    } satisfies Partial<AuthRefreshError>);
  });
});
