import { describe, expect, it } from "vitest";

import {
  profileFromMenuInput,
  renderProfileMenu,
  shouldShowProfileMenu,
} from "./profile-menu.js";

describe("profile menu", () => {
  it("only appears for bare interactive remote invocations", () => {
    expect(shouldShowProfileMenu(["node", "remote"], true)).toBe(true);
    expect(shouldShowProfileMenu(["node", "remote", "codex"], true)).toBe(
      false,
    );
    expect(shouldShowProfileMenu(["node", "remote"], false)).toBe(false);
  });

  it("renders all selectable profiles, including gemini and mistral", () => {
    const menu = renderProfileMenu("/work/project");
    expect(menu).toContain("/work/project");
    expect(menu).toContain("1. claude");
    expect(menu).toContain("4. gemini");
    expect(menu).toContain("5. mistral");
  });

  it("accepts a number, canonical name or alias", () => {
    expect(profileFromMenuInput("2\n")).toBe("codex");
    expect(profileFromMenuInput("gemini")).toBe("gemini");
    expect(profileFromMenuInput("antigravity")).toBe("agy");
    expect(profileFromMenuInput("nope")).toBeUndefined();
  });
});
