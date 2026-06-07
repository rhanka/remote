import { describe, expect, it } from "vitest";

import { gitAlignment, parsePorcelain, type GitStat } from "./gitdiff.js";

function stat(over: Partial<GitStat> = {}): GitStat {
  return { head: "a".repeat(40), branch: "main", dirty: [], ...over };
}

describe("parsePorcelain", () => {
  it("extracts file names only", () => {
    expect(parsePorcelain(" M src/a.ts\n?? new.txt\nA  added.ts\n")).toEqual([
      "src/a.ts",
      "new.txt",
      "added.ts",
    ]);
  });

  it("keeps the new name of a rename", () => {
    expect(parsePorcelain("R  old.txt -> nested/new.txt\n")).toEqual([
      "nested/new.txt",
    ]);
  });

  it("strips quotes around paths with spaces", () => {
    expect(parsePorcelain('?? "a b.txt"\n')).toEqual(["a b.txt"]);
  });

  it("returns [] for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("\n")).toEqual([]);
  });
});

describe("gitAlignment", () => {
  it("in-sync when heads match and both sides are clean", () => {
    const v = gitAlignment(stat(), stat());
    expect(v.state).toBe("in-sync");
    expect(v.detail).toContain("identical");
  });

  it("local-ahead when heads match and only local is dirty", () => {
    const v = gitAlignment(stat({ dirty: ["a.ts", "b.ts"] }), stat());
    expect(v.state).toBe("local-ahead");
    expect(v.detail).toContain("local modified: a.ts, b.ts");
    expect(v.detail).toContain("remote clean");
  });

  it("remote-ahead when heads match and only remote is dirty", () => {
    const v = gitAlignment(stat(), stat({ dirty: ["pod.ts"] }));
    expect(v.state).toBe("remote-ahead");
    expect(v.detail).toContain("remote modified: pod.ts");
  });

  it("diverged when heads match but both sides are dirty", () => {
    const v = gitAlignment(stat({ dirty: ["l.ts"] }), stat({ dirty: ["r.ts"] }));
    expect(v.state).toBe("diverged");
  });

  it("local-ahead when remote HEAD is an ancestor of local and remote is clean", () => {
    const v = gitAlignment(stat(), stat({ head: "b".repeat(40) }), "local-ahead");
    expect(v.state).toBe("local-ahead");
    expect(v.detail).toContain("HEAD differs");
  });

  it("remote-ahead when local HEAD is an ancestor of remote and local is clean", () => {
    const v = gitAlignment(stat(), stat({ head: "b".repeat(40) }), "remote-ahead");
    expect(v.state).toBe("remote-ahead");
  });

  it("diverged when heads differ with unknown ancestry", () => {
    const v = gitAlignment(stat(), stat({ head: "b".repeat(40) }), "unknown");
    expect(v.state).toBe("diverged");
  });

  it("diverged when the behind side is also dirty", () => {
    const v = gitAlignment(
      stat(),
      stat({ head: "b".repeat(40), dirty: ["r.ts"] }),
      "local-ahead",
    );
    expect(v.state).toBe("diverged");
  });

  it("missing when a side has no git repo", () => {
    expect(gitAlignment(undefined, stat()).state).toBe("missing");
    expect(gitAlignment(stat(), undefined).state).toBe("missing");
    expect(gitAlignment(undefined, undefined).state).toBe("missing");
  });

  it("reports diverging branches in the detail", () => {
    const v = gitAlignment(stat(), stat({ branch: "feature" }));
    expect(v.detail).toContain("main (local) vs feature (remote)");
  });
});
