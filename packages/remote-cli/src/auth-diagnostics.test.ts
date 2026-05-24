import { describe, expect, it } from "vitest";

import { AuthBundleMissingError } from "./auth-bundle.js";
import { inspectProfileAuth } from "./auth-diagnostics.js";
import type { RunCommand } from "./auth-refresh.js";

describe("inspectProfileAuth", () => {
  it("reports codex auth status and bundled file paths without exposing payloads", async () => {
    const runCommand: RunCommand = async () => ({
      status: 0,
      stdout: "Logged in",
      stderr: "",
    });

    const result = await inspectProfileAuth("codex", {
      home: "/home/test",
      runCommand,
      async readFileImpl(path) {
        if (path.endsWith(".codex/auth.json")) {
          return Buffer.from("secret", "utf8");
        }
        throw new Error("ENOENT");
      },
    });

    expect(result).toEqual({
      profile: "codex",
      authStatus: { checked: true, command: "codex login status" },
      bundledFiles: [".codex/auth.json"],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("throws when claude status is ok but no known credential files are present", async () => {
    const runCommand: RunCommand = async () => ({
      status: 0,
      stdout: '{"loggedIn":true}',
      stderr: "",
    });

    await expect(
      inspectProfileAuth("claude", {
        home: "/home/test",
        runCommand,
        async readFileImpl() {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toBeInstanceOf(AuthBundleMissingError);
  });

  it("can skip auth refresh and only inspect bundled codex files", async () => {
    const result = await inspectProfileAuth("codex", {
      authRefresh: false,
      home: "/home/test",
      async readFileImpl(path) {
        if (path.endsWith(".codex/config.toml")) {
          return Buffer.from("model = 'gpt-5'", "utf8");
        }
        throw new Error("ENOENT");
      },
    });

    expect(result).toEqual({
      profile: "codex",
      authStatus: { checked: false, reason: "skipped" },
      bundledFiles: [".codex/config.toml"],
    });
  });

  it("does not require bundled files for agy diagnostics", async () => {
    const result = await inspectProfileAuth("agy", {
      home: "/home/test",
      async readFileImpl() {
        throw new Error("ENOENT");
      },
    });

    expect(result).toEqual({
      profile: "agy",
      authStatus: { checked: false, reason: "no-status-command" },
      bundledFiles: [],
    });
  });
});
