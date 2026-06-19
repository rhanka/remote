import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceDescriptor } from "@sentropic/remote-protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceStore } from "./workspace-store.js";

function desc(id: string): WorkspaceDescriptor {
  return {
    id,
    createdAt: new Date().toISOString(),
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };
}

// Scratch dir under the package, never /tmp
const SCRATCH_ROOT = join(
  import.meta.dirname ?? process.cwd(),
  ".test-scratch",
  "workspace-store",
);
let scratch: string;
beforeAll(() => { mkdirSync(SCRATCH_ROOT, { recursive: true }); });
beforeEach(() => { scratch = mkdtempSync(join(SCRATCH_ROOT, "ws-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("WorkspaceStore partition", () => {
  it("lists only the owner's workspaces", () => {
    const s = new WorkspaceStore();
    s.put(desc("w1"), "alice", "ns-a");
    s.put(desc("w2"), "bob", "ns-b");
    expect(s.list("alice").map((w) => w.id)).toEqual(["w1"]);
    expect(s.get("w1", "bob")).toBeUndefined();
    expect(s.get("w1", "alice")?.id).toBe("w1");
  });

  it("delete is owner-scoped", () => {
    const s = new WorkspaceStore();
    s.put(desc("w1"), "alice", "ns-a");
    expect(s.delete("w1", "bob")).toBe(false);
    expect(s.get("w1", "alice")?.id).toBe("w1");
    expect(s.delete("w1", "alice")).toBe(true);
    expect(s.get("w1", "alice")).toBeUndefined();
  });

  it("getNamespace returns the namespace for owner", () => {
    const s = new WorkspaceStore();
    s.put(desc("w1"), "alice", "ns-alice");
    expect(s.getNamespace("w1")).toBe("ns-alice");
  });
});

describe("WorkspaceStore persistence", () => {
  it("persists put to disk and reloads on next construction", () => {
    const s1 = new WorkspaceStore(scratch);
    s1.put(desc("w1"), "alice", "ns-a");
    s1.put(desc("w2"), "bob", "ns-b");

    const s2 = new WorkspaceStore(scratch);
    expect(s2.get("w1", "alice")?.id).toBe("w1");
    expect(s2.get("w2", "bob")?.id).toBe("w2");
    expect(s2.getNamespace("w1")).toBe("ns-a");
    expect(s2.getNamespace("w2")).toBe("ns-b");
  });

  it("persists delete and does not restore deleted entries", () => {
    const s1 = new WorkspaceStore(scratch);
    s1.put(desc("w1"), "alice", "ns-a");
    s1.delete("w1", "alice");

    const s2 = new WorkspaceStore(scratch);
    expect(s2.get("w1", "alice")).toBeUndefined();
  });

  it("recovers gracefully from corrupt cp-workspaces.json", () => {
    writeFileSync(join(scratch, "cp-workspaces.json"), "not json {{{{");
    const s = new WorkspaceStore(scratch);
    expect(s.list()).toHaveLength(0);
  });

  it("works without dataDir (in-memory, no disk writes)", () => {
    const s = new WorkspaceStore();
    s.put(desc("m1"), "alice", "ns-a");
    expect(s.get("m1", "alice")?.id).toBe("m1");
  });
});
