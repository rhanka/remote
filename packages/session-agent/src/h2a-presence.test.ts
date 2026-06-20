/**
 * h2a-presence.test.ts
 *
 * Tests for safePathSegment (pure) and writePresence/clearPresence (fs).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearPresence,
  safePathSegment,
  writePresence,
} from "./h2a-presence.js";

const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "h2a-presence",
);
mkdirSync(SCRATCH_ROOT, { recursive: true });

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(SCRATCH_ROOT, "ws-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// safePathSegment — pure mapping
// ---------------------------------------------------------------------------

describe("safePathSegment", () => {
  it("leaves safe characters unchanged (alphanumeric + hyphen + dot)", () => {
    expect(safePathSegment("abc123")).toBe("abc123");
    expect(safePathSegment("a-b")).toBe("a-b"); // hyphen is NOT replaced
    expect(safePathSegment("a b")).toBe("a b"); // space is NOT replaced
  });

  it("replaces colon with __", () => {
    expect(safePathSegment("remote:abc")).toBe("remote__abc");
  });

  it("replaces slash with __", () => {
    expect(safePathSegment("a/b")).toBe("a__b");
  });

  it("replaces pipe, question mark, asterisk with __", () => {
    expect(safePathSegment("a|b")).toBe("a__b");
    expect(safePathSegment("a?b")).toBe("a__b");
    expect(safePathSegment("a*b")).toBe("a__b");
  });

  it("collapses a run of replaced chars into a single __", () => {
    expect(safePathSegment(":/")).toBe("__");
    expect(safePathSegment("a:/b")).toBe("a__b");
  });

  it("produces _ for an empty input (only fallback that returns _)", () => {
    expect(safePathSegment("")).toBe("_");
  });

  it("handles a real remote session id (colon replaced, hyphen preserved)", () => {
    const seg = safePathSegment("remote:ses-abc-123");
    expect(seg).toBe("remote__ses-abc-123");
    // Must not contain colon (invalid on Windows and in paths)
    expect(seg).not.toContain(":");
  });
});

// ---------------------------------------------------------------------------
// writePresence / clearPresence — filesystem
// ---------------------------------------------------------------------------

describe("writePresence", () => {
  const input = {
    sessionId: "ses_xyz123",
    profile: "claude",
    workspacePath: "", // set in beforeEach via ws
    workspaceId: "ws:abc",
  };

  it("creates the presence file under .h2a/presence/", () => {
    writePresence({ ...input, workspacePath: ws }, "live");
    const dir = join(ws, ".h2a", "presence");
    expect(existsSync(dir)).toBe(true);
    // Find the file (name is safePathSegment("remote:ses_xyz123").json)
    const file = join(dir, `${safePathSegment("remote:ses_xyz123")}.json`);
    expect(existsSync(file)).toBe(true);
  });

  it("presence file contains expected JSON fields", () => {
    writePresence({ ...input, workspacePath: ws }, "live");
    const file = join(
      ws,
      ".h2a",
      "presence",
      `${safePathSegment("remote:ses_xyz123")}.json`,
    );
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(doc.instance).toBe("remote:ses_xyz123");
    expect(doc.host).toBe("remote");
    expect(doc.state).toBe("live");
    expect(doc.profile).toBe("claude");
    expect(doc.workspaceId).toBe("ws:abc");
    expect(typeof doc.updatedAt).toBe("string");
  });

  it("omits workspaceId field when not provided", () => {
    writePresence({ sessionId: "ses_xyz123", profile: "codex", workspacePath: ws }, "opening");
    const file = join(
      ws,
      ".h2a",
      "presence",
      `${safePathSegment("remote:ses_xyz123")}.json`,
    );
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect("workspaceId" in doc).toBe(false);
  });

  it("overwrites the presence file on state change (closed)", () => {
    writePresence({ ...input, workspacePath: ws }, "live");
    writePresence({ ...input, workspacePath: ws }, "closed");
    const file = join(
      ws,
      ".h2a",
      "presence",
      `${safePathSegment("remote:ses_xyz123")}.json`,
    );
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(doc.state).toBe("closed");
  });
});

describe("clearPresence", () => {
  const input = {
    sessionId: "ses_xyz123",
    profile: "claude",
    workspacePath: "", // set per test
  };

  it("removes the presence file when it exists", () => {
    writePresence({ ...input, workspacePath: ws }, "live");
    clearPresence({ ...input, workspacePath: ws });
    const file = join(
      ws,
      ".h2a",
      "presence",
      `${safePathSegment("remote:ses_xyz123")}.json`,
    );
    expect(existsSync(file)).toBe(false);
  });

  it("is a no-op when the presence file does not exist (force:true)", () => {
    expect(() =>
      clearPresence({ ...input, workspacePath: ws }),
    ).not.toThrow();
  });
});
