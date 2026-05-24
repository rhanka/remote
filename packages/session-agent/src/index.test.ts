import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { materializeAuthBundle } from "./index.js";

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
