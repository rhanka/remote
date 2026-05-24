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
    expect(resolveProfile("shell").command).toBe("/bin/bash");
  });

  it("rejects unknown profiles", () => {
    expect(() => resolveProfile("not-a-profile")).toThrow(/Unknown profile/);
  });

  it("withResume appends the profile-specific flag when a session id is given", () => {
    const codex = resolveProfile("codex");
    expect(withResume(codex, "abc").args).toEqual(["--continue", "abc"]);
    expect(withResume(codex, undefined).args).toEqual([]);

    const shell = resolveProfile("shell");
    expect(withResume(shell, "abc").args).toEqual([]);
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
    expect(coerceCliProfileName("codex")).toBe("codex");
    expect(coerceCliProfileName("not-real")).toBeUndefined();
  });
});
