import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRegistry, type WorkspaceEntry } from "./workspace-registry.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cp-ws-registry-test-"));
}

function makeEntry(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    wsId: "ws:abc123",
    subPath: "test-sub",
    owner: "user-1",
    lineageIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("WorkspaceRegistry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsert then get returns the entry", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    const entry = makeEntry();
    reg.upsertWorkspace(entry);
    const result = reg.getWorkspace(entry.wsId);
    expect(result).toEqual(entry);
  });

  it("getWorkspace returns undefined for unknown wsId", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    expect(reg.getWorkspace("ws:nonexistent")).toBeUndefined();
  });

  it("listWorkspaces without owner returns all entries", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    const e1 = makeEntry({ wsId: "ws:a1", owner: "alice" });
    const e2 = makeEntry({ wsId: "ws:b2", owner: "bob" });
    reg.upsertWorkspace(e1);
    reg.upsertWorkspace(e2);
    const all = reg.listWorkspaces();
    expect(all).toHaveLength(2);
  });

  it("listWorkspaces with owner filters by owner", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    const e1 = makeEntry({ wsId: "ws:a1", owner: "alice" });
    const e2 = makeEntry({ wsId: "ws:b2", owner: "bob" });
    const e3 = makeEntry({ wsId: "ws:a3", owner: "alice" });
    reg.upsertWorkspace(e1);
    reg.upsertWorkspace(e2);
    reg.upsertWorkspace(e3);
    const aliceEntries = reg.listWorkspaces("alice");
    expect(aliceEntries).toHaveLength(2);
    expect(aliceEntries.every((e) => e.owner === "alice")).toBe(true);
  });

  it("persists to disk and reloads on new instance", () => {
    const entry = makeEntry({ wsId: "ws:persist", owner: "user-persist" });
    {
      const reg = new WorkspaceRegistry(tmpDir);
      reg.upsertWorkspace(entry);
    }
    // Create a fresh instance pointing at same dir — should reload from disk
    const reg2 = new WorkspaceRegistry(tmpDir);
    const result = reg2.getWorkspace(entry.wsId);
    expect(result).toEqual(entry);
  });

  it("upsert is idempotent — updates existing entry", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    const entry = makeEntry({ wsId: "ws:idem", lineageIds: [] });
    reg.upsertWorkspace(entry);
    const updated = { ...entry, lineageIds: ["lin_abc"] };
    reg.upsertWorkspace(updated);
    expect(reg.getWorkspace(entry.wsId)?.lineageIds).toEqual(["lin_abc"]);
    expect(reg.listWorkspaces()).toHaveLength(1);
  });

  it("starts empty if dataDir does not contain workspaces.json", () => {
    const reg = new WorkspaceRegistry(tmpDir);
    expect(reg.listWorkspaces()).toHaveLength(0);
  });
});
