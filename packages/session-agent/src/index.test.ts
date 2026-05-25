import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { materializeAuthBundle, materializeWorkspace } from "./index.js";

function setupStage(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "session-agent-test-"));
  for (const [rel, value] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(abs, value, { mode: 0o400 });
  }
  return root;
}

describe("materializeAuthBundle", () => {
  it("copies each declared file from staging to HOME with mode 0o600", () => {
    const staging = setupStage({
      ".codex/auth.json": "codex-token",
      ".claude/.credentials.json": "claude-token",
    });
    const home = mkdtempSync(join(tmpdir(), "session-agent-home-"));

    const copied = materializeAuthBundle(
      staging,
      ".codex/auth.json:.claude/.credentials.json",
      home,
    );

    expect(copied).toEqual([
      ".codex/auth.json",
      ".claude/.credentials.json",
    ]);
    expect(readFileSync(join(home, ".codex/auth.json"), "utf8")).toBe(
      "codex-token",
    );
    expect(readFileSync(join(home, ".claude/.credentials.json"), "utf8")).toBe(
      "claude-token",
    );
    const stat = statSync(join(home, ".codex/auth.json"));
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  it("returns an empty list when staging dir or paths are missing", () => {
    const home = mkdtempSync(join(tmpdir(), "session-agent-home-"));
    expect(materializeAuthBundle(undefined, undefined, home)).toEqual([]);
    expect(materializeAuthBundle("/run/auth-bundle", undefined, home)).toEqual(
      [],
    );
    expect(materializeAuthBundle(undefined, ".codex/auth.json", home)).toEqual(
      [],
    );
  });

  it("skips files that are not present in staging without throwing", () => {
    const staging = setupStage({ ".codex/auth.json": "ok" });
    const home = mkdtempSync(join(tmpdir(), "session-agent-home-"));

    const copied = materializeAuthBundle(
      staging,
      ".codex/auth.json:.gemini/oauth_creds.json",
      home,
    );

    expect(copied).toEqual([".codex/auth.json"]);
  });
});

describe("materializeWorkspace", () => {
  it("fetches and extracts the archive into the workspace", async () => {
    const archive = new Uint8Array([1, 2, 3]);
    let extractedTo = "";
    const extracted = await materializeWorkspace({
      controlPlaneEndpoint: "http://cp:8080",
      sessionId: "sess-x",
      workspacePath: "/workspace",
      fetchArchive: async (url) => {
        expect(url).toBe("http://cp:8080/sessions/sess-x/workspace");
        return archive;
      },
      extract: async (_a, dest) => {
        extractedTo = dest;
      },
    });
    expect(extracted).toBe(true);
    expect(extractedTo).toBe("/workspace");
  });

  it("retries until the archive is staged, then extracts", async () => {
    let calls = 0;
    const extracted = await materializeWorkspace({
      controlPlaneEndpoint: "http://cp:8080",
      sessionId: "sess-y",
      workspacePath: "/workspace",
      retries: 5,
      delayMs: 0,
      sleep: async () => {},
      fetchArchive: async () => {
        calls += 1;
        return calls < 3 ? null : new Uint8Array([9]);
      },
      extract: async () => {},
    });
    expect(extracted).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns false when no archive is ever staged", async () => {
    const extracted = await materializeWorkspace({
      controlPlaneEndpoint: "http://cp:8080",
      sessionId: "sess-z",
      workspacePath: "/workspace",
      retries: 2,
      delayMs: 0,
      sleep: async () => {},
      fetchArchive: async () => null,
      extract: async () => {
        throw new Error("should not extract");
      },
    });
    expect(extracted).toBe(false);
  });
});
