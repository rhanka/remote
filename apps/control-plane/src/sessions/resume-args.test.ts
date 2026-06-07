import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  applyFreshResume,
  descriptorWithFreshResume,
  startupArgsOf,
} from "./resume-args.js";

function descriptor(
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    id: "sess-1",
    profile: "claude",
    target: "k3s",
    workspacePath: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: { id: "control-plane", kind: "control-plane" },
    ...overrides,
  };
}

describe("applyFreshResume", () => {
  it("substitutes a stale claude --resume value with the fresh id", () => {
    const result = applyFreshResume(
      "claude",
      ["--resume", "conv-old", "--model", "opus"],
      "conv-new",
    );
    expect(result.action).toBe("substituted");
    expect(result.previous).toBe("conv-old");
    // Order and unrelated args preserved verbatim.
    expect(result.args).toEqual(["--resume", "conv-new", "--model", "opus"]);
  });

  it("substitutes a stale codex `resume <id>` subcommand value", () => {
    const result = applyFreshResume("codex", ["resume", "conv-old"], "conv-new");
    expect(result.action).toBe("substituted");
    expect(result.args).toEqual(["resume", "conv-new"]);
  });

  it("substitutes a stale codex/agy --continue value (what migrate generates)", () => {
    expect(
      applyFreshResume("codex", ["--continue", "conv-old"], "conv-new").args,
    ).toEqual(["--continue", "conv-new"]);
    expect(
      applyFreshResume("agy", ["--continue", "conv-old"], "conv-new").args,
    ).toEqual(["--continue", "conv-new"]);
  });

  it("leaves args intact when the resume id is already the fresh one", () => {
    const args = ["--resume", "conv-current"];
    const result = applyFreshResume("claude", args, "conv-current");
    expect(result.action).toBe("unchanged");
    expect(result.args).toBe(args);
  });

  it("fills a bare --resume (picker form) with the fresh id", () => {
    const result = applyFreshResume("claude", ["--resume"], "conv-new");
    expect(result.action).toBe("inserted");
    expect(result.args).toEqual(["--resume", "conv-new"]);
  });

  it("fills a bare resume token even when followed by another flag", () => {
    const result = applyFreshResume(
      "claude",
      ["--resume", "--model", "opus"],
      "conv-new",
    );
    expect(result.action).toBe("inserted");
    expect(result.args).toEqual(["--resume", "conv-new", "--model", "opus"]);
  });

  it("appends --resume <id> for claude when no resume arg exists", () => {
    const result = applyFreshResume("claude", ["--model", "opus"], "conv-new");
    expect(result.action).toBe("added");
    expect(result.args).toEqual(["--model", "opus", "--resume", "conv-new"]);
  });

  it("appends --resume <id> for claude when args are empty", () => {
    const result = applyFreshResume("claude", [], "conv-new");
    expect(result.action).toBe("added");
    expect(result.args).toEqual(["--resume", "conv-new"]);
  });

  it("prepends the codex resume subcommand when no resume arg exists", () => {
    const result = applyFreshResume("codex", ["--model", "o4"], "conv-new");
    expect(result.action).toBe("added");
    // `codex resume <id>` is a subcommand — it must lead the argv.
    expect(result.args).toEqual(["resume", "conv-new", "--model", "o4"]);
  });

  it("never touches profiles without a resume concept", () => {
    for (const profile of ["shell", "opencode"]) {
      const args = ["-c", "echo hi"];
      const result = applyFreshResume(profile, args, "conv-new");
      expect(result.action).toBe("unchanged");
      expect(result.args).toBe(args);
    }
  });

  it("only rewrites the FIRST resume couple", () => {
    const result = applyFreshResume(
      "claude",
      ["--resume", "conv-a", "--resume", "conv-b"],
      "conv-new",
    );
    expect(result.args).toEqual(["--resume", "conv-new", "--resume", "conv-b"]);
  });
});

describe("startupArgsOf", () => {
  it("reads metadata.startup.args exactly like buildSessionPodSpec", () => {
    expect(
      startupArgsOf(
        descriptor({ metadata: { startup: { args: ["--resume", "c1"] } } }),
      ),
    ).toEqual(["--resume", "c1"]);
  });

  it("is defensive about malformed metadata shapes", () => {
    expect(startupArgsOf(descriptor())).toEqual([]);
    expect(startupArgsOf(descriptor({ metadata: {} }))).toEqual([]);
    expect(startupArgsOf(descriptor({ metadata: { startup: "x" } }))).toEqual(
      [],
    );
    expect(
      startupArgsOf(descriptor({ metadata: { startup: { args: "x" } } })),
    ).toEqual([]);
    expect(
      startupArgsOf(descriptor({ metadata: { startup: { args: [1, "a"] } } })),
    ).toEqual(["a"]);
  });
});

describe("descriptorWithFreshResume", () => {
  it("returns the SAME object when no cliSessionId is known (old agent compat)", () => {
    const d = descriptor({
      metadata: { startup: { args: ["--resume", "conv-old"] } },
    });
    const result = descriptorWithFreshResume(d);
    expect(result.action).toBe("unchanged");
    expect(result.descriptor).toBe(d);
  });

  it("returns the SAME object when the resume id is already fresh", () => {
    const d = descriptor({
      cliSessionId: "conv-current",
      metadata: { startup: { args: ["--resume", "conv-current"] } },
    });
    const result = descriptorWithFreshResume(d);
    expect(result.action).toBe("unchanged");
    expect(result.descriptor).toBe(d);
  });

  it("rewrites the startup args in place (metadata siblings preserved)", () => {
    const d = descriptor({
      cliSessionId: "conv-new",
      metadata: {
        custom: "kept",
        startup: { args: ["--resume", "conv-old"], shell: "kept-too" },
      },
    });
    const result = descriptorWithFreshResume(d);
    expect(result.action).toBe("substituted");
    expect(result.previous).toBe("conv-old");
    expect(result.descriptor.metadata).toEqual({
      custom: "kept",
      startup: { args: ["--resume", "conv-new"], shell: "kept-too" },
    });
    // Pure: the input descriptor is not mutated.
    expect(d.metadata).toEqual({
      custom: "kept",
      startup: { args: ["--resume", "conv-old"], shell: "kept-too" },
    });
  });

  it("creates metadata.startup.args when the session had no startup args at all", () => {
    const d = descriptor({ cliSessionId: "conv-new" });
    const result = descriptorWithFreshResume(d);
    expect(result.action).toBe("added");
    expect(result.descriptor.metadata).toEqual({
      startup: { args: ["--resume", "conv-new"] },
    });
  });
});
