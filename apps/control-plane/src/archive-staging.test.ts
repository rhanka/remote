import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArchiveStaging } from "./archive-staging.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cp-archive-staging-test-"));
}

describe("ArchiveStaging", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stageArchive writes and readStagedArchive reads back", () => {
    const staging = new ArchiveStaging(tmpDir);
    const data = Buffer.from("fake-tar-gz-content");
    const path = staging.stageArchive("sess-001", data);
    expect(typeof path).toBe("string");
    const result = staging.readStagedArchive("sess-001");
    expect(result).not.toBeNull();
    expect(result!.equals(data)).toBe(true);
  });

  it("readStagedArchive returns null for unknown sessionId", () => {
    const staging = new ArchiveStaging(tmpDir);
    const result = staging.readStagedArchive("nonexistent-session");
    expect(result).toBeNull();
  });

  it("clearStagedArchive removes the archive", () => {
    const staging = new ArchiveStaging(tmpDir);
    const data = Buffer.from("content");
    staging.stageArchive("sess-clear", data);
    expect(staging.readStagedArchive("sess-clear")).not.toBeNull();
    staging.clearStagedArchive("sess-clear");
    expect(staging.readStagedArchive("sess-clear")).toBeNull();
  });

  it("clearStagedArchive is a no-op for missing session", () => {
    const staging = new ArchiveStaging(tmpDir);
    // Should not throw
    expect(() => staging.clearStagedArchive("no-such-session")).not.toThrow();
  });

  it("supports custom subDir", () => {
    const staging = new ArchiveStaging(tmpDir, "custom-staging");
    const data = Buffer.from("custom-data");
    staging.stageArchive("sess-custom", data);
    const result = staging.readStagedArchive("sess-custom");
    expect(result?.equals(data)).toBe(true);
  });

  it("two instances with different subDirs don't share archives", () => {
    const s1 = new ArchiveStaging(tmpDir, "staging-a");
    const s2 = new ArchiveStaging(tmpDir, "staging-b");
    s1.stageArchive("sess-x", Buffer.from("in-a"));
    expect(s2.readStagedArchive("sess-x")).toBeNull();
  });
});
