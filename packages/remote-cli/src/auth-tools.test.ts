import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KNOWN_TOOLS,
  TOOL_AUTH_INFO,
  localCredsExistFor,
  partitionTools,
} from "./auth-tools.js";

describe("TOOL_AUTH npm/docker coverage (slice 2)", () => {
  it("npm and docker are now KNOWN_TOOLS", () => {
    expect(KNOWN_TOOLS).toContain("npm");
    expect(KNOWN_TOOLS).toContain("docker");
  });

  it("npm spec is well-formed (~/.npmrc, primary file decides present)", () => {
    const npmFiles = TOOL_AUTH_INFO.filter((i) => i.tool === "npm");
    expect(npmFiles.map((i) => i.relpath)).toEqual([".npmrc"]);
    // npm token is per-registry, not an account-wide cloud key → NOT broad.
    expect(npmFiles.every((i) => i.broad === false)).toBe(true);
  });

  it("docker spec is well-formed (~/.docker/config.json)", () => {
    const dockerFiles = TOOL_AUTH_INFO.filter((i) => i.tool === "docker");
    expect(dockerFiles.map((i) => i.relpath)).toEqual([".docker/config.json"]);
    expect(dockerFiles.every((i) => i.broad === false)).toBe(true);
  });

  it("every TOOL_AUTH_INFO entry has a non-empty relpath + tool", () => {
    for (const info of TOOL_AUTH_INFO) {
      expect(info.relpath.length).toBeGreaterThan(0);
      expect(info.tool.length).toBeGreaterThan(0);
      expect(typeof info.broad).toBe("boolean");
    }
  });

  it("partitionTools accepts npm/docker, still rejects unknown", () => {
    const { known, unknown } = partitionTools(["npm", "docker", "scw", "bogus"]);
    expect(known).toEqual(["npm", "docker", "scw"]);
    expect(unknown).toEqual(["bogus"]);
  });
});

// Scratch HOME inside the package (never /tmp) for the local-creds guard matrix.
const SCRATCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".auth-test");
let home: string;

describe("localCredsExistFor — exists+nonempty matrix (slice-2 push guard)", () => {
  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    home = mkdtempSync(join(SCRATCH_ROOT, "h-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const writeRel = (rel: string, body: string) => {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, "utf8");
  };

  it("no local file → false (skip: pushing nothing is pointless)", () => {
    expect(localCredsExistFor("npm", home)).toBe(false);
    expect(localCredsExistFor("docker", home)).toBe(false);
  });

  it("empty (zero-byte) local file → false (no auth to push)", () => {
    writeRel(".npmrc", "");
    writeRel(".docker/config.json", "");
    expect(localCredsExistFor("npm", home)).toBe(false);
    expect(localCredsExistFor("docker", home)).toBe(false);
  });

  it("non-empty local file → true (real creds to push)", () => {
    writeRel(".npmrc", "//registry.npmjs.org/:_authToken=xxx\n");
    writeRel(".docker/config.json", '{"auths":{"r":{"auth":"x"}}}');
    expect(localCredsExistFor("npm", home)).toBe(true);
    expect(localCredsExistFor("docker", home)).toBe(true);
  });

  it("unknown tool → false", () => {
    expect(localCredsExistFor("bogus", home)).toBe(false);
  });
});
