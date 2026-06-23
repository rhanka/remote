import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";

function desc(id: string): SessionDescriptor {
  return {
    id,
    profile: "shell",
    target: "k3s",
    workspacePath: "/workspace",
    createdAt: new Date().toISOString(),
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };
}

// Scratch dir for persistence tests (under the package, never /tmp)
const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  "..",
  ".test-scratch",
  "session-store",
);
let scratch: string;
beforeAll(() => { mkdirSync(SCRATCH_ROOT, { recursive: true }); });
beforeEach(() => { scratch = mkdtempSync(join(SCRATCH_ROOT, "ss-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("SessionStore partition", () => {
  it("lists only the owner's sessions and hides others", () => {
    const s = new SessionStore();
    s.put(desc("a1"), "alice");
    s.put(desc("b1"), "bob");
    expect(s.list("alice").map((d) => d.id)).toEqual(["a1"]);
    expect(s.get("a1", "bob")).toBeUndefined();
    expect(s.get("a1", "alice")?.id).toBe("a1");
  });

  it("hides delete across owners", () => {
    const s = new SessionStore();
    s.put(desc("a1"), "alice");
    expect(s.delete("a1", "bob")).toBe(false);
    expect(s.get("a1", "alice")?.id).toBe("a1");
    expect(s.delete("a1", "alice")).toBe(true);
    expect(s.get("a1", "alice")).toBeUndefined();
  });
});

describe("SessionStore.getByDisplayName", () => {
  it("returns the session when exactly one matches (case-insensitive)", () => {
    const s = new SessionStore();
    const d = { ...desc("s1"), displayName: "geo-flotte-lasarre" };
    s.put(d, "alice");
    expect(s.getByDisplayName("geo-flotte-lasarre", "alice")?.id).toBe("s1");
    expect(s.getByDisplayName("GEO-FLOTTE-LASARRE", "alice")?.id).toBe("s1");
  });

  it("returns undefined when no match", () => {
    const s = new SessionStore();
    s.put({ ...desc("s1"), displayName: "other" }, "alice");
    expect(s.getByDisplayName("geo-flotte-lasarre", "alice")).toBeUndefined();
  });

  it("returns undefined when multiple sessions share the same displayName (ambiguous)", () => {
    const s = new SessionStore();
    s.put({ ...desc("s1"), displayName: "shared" }, "alice");
    s.put({ ...desc("s2"), displayName: "shared" }, "alice");
    expect(s.getByDisplayName("shared", "alice")).toBeUndefined();
  });

  it("respects owner partitioning", () => {
    const s = new SessionStore();
    s.put({ ...desc("s1"), displayName: "named" }, "alice");
    expect(s.getByDisplayName("named", "bob")).toBeUndefined();
    expect(s.getByDisplayName("named", "alice")?.id).toBe("s1");
  });
});

describe("SessionStore persistence (durable store)", () => {
  it("persists put to disk and reloads on next construction", () => {
    const s1 = new SessionStore(scratch);
    s1.put(desc("s1"), "alice");
    s1.put(desc("s2"), "bob");

    const s2 = new SessionStore(scratch);
    expect(s2.get("s1", "alice")?.id).toBe("s1");
    expect(s2.get("s2", "bob")?.id).toBe("s2");
    expect(s2.get("s1", "bob")).toBeUndefined();
  });

  it("persists delete and does not restore deleted sessions", () => {
    const s1 = new SessionStore(scratch);
    s1.put(desc("d1"), "alice");
    s1.delete("d1", "alice");

    const s2 = new SessionStore(scratch);
    expect(s2.get("d1", "alice")).toBeUndefined();
  });

  it("recovers gracefully from corrupt sessions.json", () => {
    writeFileSync(join(scratch, "sessions.json"), "not json {{{{");

    const s = new SessionStore(scratch);
    expect(s.list()).toHaveLength(0);
  });

  it("works without dataDir (in-memory, no disk writes)", () => {
    const s = new SessionStore();
    s.put(desc("m1"), "alice");
    expect(s.get("m1", "alice")?.id).toBe("m1");
  });
});
