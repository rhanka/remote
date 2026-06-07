import { describe, expect, it } from "vitest";

import { decideSyncAction, localConvFile, remoteConvRel } from "./sync.js";

describe("decideSyncAction (ahead-guard)", () => {
  it("allows pull when remote is ahead", () => {
    expect(
      decideSyncAction({ localLines: 10, remoteLines: 25, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows pull when both sides are equal", () => {
    expect(
      decideSyncAction({ localLines: 10, remoteLines: 10, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("refuses pull when local is ahead (would lose local lines)", () => {
    const d = decideSyncAction({
      localLines: 30,
      remoteLines: 10,
      direction: "pull",
      force: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("local conversation is ahead");
      expect(d.reason).toContain("30 vs 10");
      expect(d.reason).toContain("20 local line(s)");
      expect(d.reason).toContain("--force");
    }
  });

  it("allows pull over an ahead local with --force", () => {
    expect(
      decideSyncAction({ localLines: 30, remoteLines: 10, direction: "pull", force: true }),
    ).toEqual({ allow: true });
  });

  it("allows push when local is ahead", () => {
    expect(
      decideSyncAction({ localLines: 25, remoteLines: 10, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows push when both sides are equal", () => {
    expect(
      decideSyncAction({ localLines: 7, remoteLines: 7, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });

  it("refuses push when remote is ahead (would lose remote lines)", () => {
    const d = decideSyncAction({
      localLines: 5,
      remoteLines: 12,
      direction: "push",
      force: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("remote conversation is ahead");
      expect(d.reason).toContain("12 vs 5");
      expect(d.reason).toContain("7 remote line(s)");
      expect(d.reason).toContain("--force");
    }
  });

  it("allows push over an ahead remote with --force", () => {
    expect(
      decideSyncAction({ localLines: 5, remoteLines: 12, direction: "push", force: true }),
    ).toEqual({ allow: true });
  });

  it("allows pull when there is no local conversation at all (0 lines)", () => {
    expect(
      decideSyncAction({ localLines: 0, remoteLines: 42, direction: "pull", force: false }),
    ).toEqual({ allow: true });
  });

  it("allows push when the remote file does not exist yet (0 lines)", () => {
    expect(
      decideSyncAction({ localLines: 42, remoteLines: 0, direction: "push", force: false }),
    ).toEqual({ allow: true });
  });
});

describe("conversation paths (claude cwd encoding, slashes → dashes)", () => {
  it("localConvFile builds the local jsonl path under ~/.claude/projects", () => {
    expect(localConvFile("/home/dev/src/app", "abc-123", "/home/dev")).toBe(
      "/home/dev/.claude/projects/-home-dev-src-app/abc-123.jsonl",
    );
  });

  it("remoteConvRel builds the $HOME-relative Pod path with the same encoding", () => {
    expect(remoteConvRel("/data/workspaces/w1/repo", "abc-123")).toBe(
      ".claude/projects/-data-workspaces-w1-repo/abc-123.jsonl",
    );
  });

  it("local and remote use the SAME encoding for the same workspace", () => {
    const ws = "/home/dev/src/remote";
    const local = localConvFile(ws, "c1", "/home/dev");
    const rel = remoteConvRel(ws, "c1");
    expect(local.endsWith(rel)).toBe(true);
  });
});
