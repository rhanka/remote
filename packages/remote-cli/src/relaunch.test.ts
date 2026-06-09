import { describe, expect, it } from "vitest";

import { planRelaunch, resumeCommandFor } from "./relaunch.js";

describe("resumeCommandFor", () => {
  it("uses --resume for claude/agy and the resume subcommand for codex", () => {
    expect(resumeCommandFor("claude", "c1")).toBe("claude --resume c1");
    expect(resumeCommandFor("agy", "c1")).toBe("agy --resume c1");
    expect(resumeCommandFor("codex", "r1")).toBe("codex resume r1");
  });
  it("returns undefined for a profile with no resume form", () => {
    expect(resumeCommandFor("shell", "x")).toBeUndefined();
    expect(resumeCommandFor("not-a-profile", "x")).toBeUndefined();
  });
});

describe("planRelaunch", () => {
  const idleClaude = (slug: string, convId?: string) => ({
    slug,
    name: `remote-${slug}`,
    profile: "claude",
    idle: true,
    ...(convId ? { convId } : {}),
  });

  it("plans idle sessions with a known convId, each its own command", () => {
    const plan = planRelaunch([
      idleClaude("sentropic", "c-a"),
      idleClaude("sentropic#2", "c-b"),
      { ...idleClaude("dataviz", "r-1"), profile: "codex" },
    ]);
    expect(plan.actions.map((a) => a.cmd)).toEqual([
      "claude --resume c-a",
      "claude --resume c-b",
      "codex resume r-1",
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("leaves running sessions alone", () => {
    const plan = planRelaunch([
      { ...idleClaude("live", "c-x"), idle: false },
    ]);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/running/);
  });

  it("skips sessions with no convId rather than guessing", () => {
    const plan = planRelaunch([idleClaude("opendb")]);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/no convId/);
  });

  it("refuses to point two sessions at the SAME conversation", () => {
    const plan = planRelaunch([
      idleClaude("a", "dup"),
      idleClaude("b", "dup"),
    ]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.slug).toBe("a");
    expect(plan.skipped[0]?.reason).toMatch(/collide/);
  });
});
