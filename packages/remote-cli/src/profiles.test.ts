import { describe, expect, it } from "vitest";

import {
  coerceCliProfileName,
  isCliProfile,
  resolveProfile,
  withResume,
} from "./profiles.js";

describe("profiles", () => {
  it("resolves known profiles to their binary command", () => {
    expect(resolveProfile("codex").command).toBe("codex");
    expect(resolveProfile("claude").command).toBe("claude");
    expect(resolveProfile("agy").command).toBe("agy");
    expect(resolveProfile("gemini").command).toBe("gemini");
    expect(resolveProfile("mistral").command).toBe("mistral");
    expect(resolveProfile("shell").command).toBe("/bin/bash");
  });

  it("rejects unknown profiles", () => {
    expect(() => resolveProfile("not-a-profile")).toThrow(/Unknown profile/);
  });

  it("withResume builds the profile-specific resume argv", () => {
    // codex resumes via a SUBCOMMAND that must lead the argv.
    const codex = resolveProfile("codex");
    expect(withResume(codex, "abc").args).toEqual(["resume", "abc"]);
    expect(withResume(codex, true).args).toEqual(["resume", "--last"]);
    expect(withResume(codex, undefined).args).toEqual([]);

    // claude: explicit id → --resume <id>; most recent → --continue (bare
    // --resume would open the interactive picker).
    const claude = resolveProfile("claude");
    expect(withResume(claude, "abc").args).toEqual(["--resume", "abc"]);
    expect(withResume(claude, true).args).toEqual(["--continue"]);

    const shell = resolveProfile("shell");
    expect(withResume(shell, "abc").args).toEqual([]);

    const gemini = resolveProfile("gemini");
    expect(withResume(gemini, "abc").args).toEqual([]);
    const mistral = resolveProfile("mistral");
    expect(withResume(mistral, "abc").args).toEqual([]);
  });

  it("isCliProfile narrows known names", () => {
    expect(isCliProfile("codex")).toBe(true);
    expect(isCliProfile("not-real")).toBe(false);
  });

  it("coerces CLI aliases to canonical profile names", () => {
    expect(coerceCliProfileName("claude")).toBe("claude");
    expect(coerceCliProfileName("claude-code")).toBe("claude");
    expect(coerceCliProfileName("agy")).toBe("agy");
    expect(coerceCliProfileName("antigravity")).toBe("agy");
    expect(coerceCliProfileName("gemini-cli")).toBe("gemini");
    expect(coerceCliProfileName("mistralcli")).toBe("mistral");
    expect(coerceCliProfileName("codex")).toBe("codex");
    expect(coerceCliProfileName("not-real")).toBeUndefined();
  });
});
