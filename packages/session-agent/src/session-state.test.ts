import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  canonicalizeConversationKey,
  detectCliSessionId,
  projectKeyForCwd,
  restoreSessionState,
  snapshotSessionState,
} from "./session-state.js";

// Scratch lives under the package (gitignored), never /tmp. A file-specific
// root so the parallel redirect-storage.test.ts (same src dir) can't race this
// suite's afterAll rmSync against the other's writes (ENOTEMPTY).
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  ".state-test-session",
);

function tmp(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}

function writeAt(path: string, body: string, mtimeSec: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, mtimeSec, mtimeSec);
}

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("detectCliSessionId", () => {
  it("returns the uuid of the most-recently-modified file across nested dirs", () => {
    const home = tmp("home-");
    const older = "11111111-1111-1111-1111-111111111111";
    const newer = "22222222-2222-2222-2222-222222222222";
    // claude state dir is .claude/projects; nest under a project subdir.
    writeAt(
      join(home, ".claude/projects/proj-a", `${older}.jsonl`),
      "{}",
      1000,
    );
    writeAt(
      join(home, ".claude/projects/proj-b", `${newer}.jsonl`),
      "{}",
      2000,
    );
    expect(detectCliSessionId("claude", home)).toBe(newer);
  });

  it("falls back to the filename stem when no uuid is present", () => {
    const home = tmp("home-");
    writeAt(join(home, ".codex/sessions/rollout-2026-05-28.json"), "{}", 1000);
    expect(detectCliSessionId("codex", home)).toBe("rollout-2026-05-28");
  });

  it("detects agy conversations under its own state dir", () => {
    const home = tmp("home-");
    const id = "33333333-3333-3333-3333-333333333333";
    writeAt(
      join(home, ".gemini/antigravity-cli/conversations", `${id}.json`),
      "{}",
      1500,
    );
    expect(detectCliSessionId("agy", home)).toBe(id);
  });

  it("detects gemini conversations under the explicit gemini-cli state dir", () => {
    const home = tmp("home-");
    const id = "44444444-4444-4444-4444-444444444444";
    writeAt(
      join(home, ".gemini/gemini-cli/conversations", `${id}.json`),
      "{}",
      1600,
    );
    expect(detectCliSessionId("gemini", home)).toBe(id);
  });

  it("returns undefined when the profile has no state dir or no files", () => {
    const home = tmp("home-");
    expect(detectCliSessionId("shell", home)).toBeUndefined();
    expect(detectCliSessionId("claude", home)).toBeUndefined();
  });
});

describe("snapshot/restore round-trip across profiles", () => {
  it.each([
    ["claude", ".claude/projects/proj/conv.jsonl"],
    ["agy", ".gemini/antigravity-cli/conversations/conv.json"],
    ["gemini", ".gemini/gemini-cli/conversations/conv.json"],
    // alias: claude-code maps to the same state dir as claude
    ["claude-code", ".claude/projects/proj/conv.jsonl"],
  ])("persists %s state through the workspace", (profile, rel) => {
    const home1 = tmp("home1-");
    const ws = tmp("ws-");
    const home2 = tmp("home2-");
    writeAt(join(home1, rel), "conversation-body", 1000);

    const saved = snapshotSessionState(profile, home1, ws);
    expect(saved.length).toBeGreaterThan(0);

    const restored = restoreSessionState(profile, home2, ws);
    expect(restored.length).toBeGreaterThan(0);

    // The conversation file survives the home1 -> workspace -> home2 trip.
    expect(detectCliSessionId(profile, home2)).toBe("conv");
  });

  it("is a no-op for profiles without a state dir", () => {
    const home = tmp("home-");
    const ws = tmp("ws-");
    expect(snapshotSessionState("shell", home, ws)).toEqual([]);
    expect(restoreSessionState("opencode", home, ws)).toEqual([]);
  });
});

describe("projectKeyForCwd", () => {
  it("path-encodes an absolute cwd the way claude does (/ → -)", () => {
    expect(projectKeyForCwd("/workspace")).toBe("-workspace");
    expect(projectKeyForCwd("/home/antoinefa/src/foo")).toBe(
      "-home-antoinefa-src-foo",
    );
  });
});

describe("canonicalizeConversationKey", () => {
  const CONV = "abcd1234-1111-2222-3333-444455556666";

  it("copies a migrated conversation into the cwd's canonical project key", () => {
    const home = tmp("home-");
    // Staged by `remote migrate` under the user's LOCAL path key.
    const localKey = "-home-antoinefa-src-foo";
    writeAt(
      join(home, ".claude/projects", localKey, `${CONV}.jsonl`),
      "conv",
      1000,
    );

    const result = canonicalizeConversationKey("claude", home, "/workspace");
    expect(result.canonicalKey).toBe("-workspace");
    expect(result.copied).toEqual([`${CONV}.jsonl`]);
    // Now resolvable by `claude --resume` running in cwd=/workspace.
    expect(detectCliSessionId("claude", home)).toBe(CONV);
  });

  it("is a no-op when the newest conversation already lives under the canonical key", () => {
    const home = tmp("home-");
    writeAt(
      join(home, ".claude/projects", "-workspace", `${CONV}.jsonl`),
      "conv",
      1000,
    );
    const result = canonicalizeConversationKey("claude", home, "/workspace");
    expect(result.copied).toEqual([]);
  });

  it("leaves a newer native conversation at the canonical key untouched", () => {
    const home = tmp("home-");
    const other = "ffffffff-0000-0000-0000-000000000000";
    // A NEWER native conv at the canonical key + an older migrated one under a
    // local key: the newest already resolves under the cwd, so it's a no-op and
    // the native conv is never overwritten.
    writeAt(
      join(home, ".claude/projects", "-workspace", `${CONV}.jsonl`),
      "native",
      2000,
    );
    writeAt(
      join(home, ".claude/projects", "-other-path", `${other}.jsonl`),
      "older",
      1000,
    );
    const result = canonicalizeConversationKey("claude", home, "/workspace");
    expect(result.copied).toEqual([]);
  });

  it("is a no-op for non-path-encoded profiles (codex/agy)", () => {
    const home = tmp("home-");
    expect(
      canonicalizeConversationKey("codex", home, "/workspace").copied,
    ).toEqual([]);
    expect(
      canonicalizeConversationKey("agy", home, "/workspace").copied,
    ).toEqual([]);
  });
});
