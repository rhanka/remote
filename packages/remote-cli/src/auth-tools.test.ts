import { describe, expect, it } from "vitest";

import {
  KNOWN_TOOLS,
  TOOL_AUTH_INFO,
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
