import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleClaudeHook, installClaudeHooks, manualEnroll } from "./enroll.js";
import { loadRegistry } from "./registry.js";

// Scratch dir inside the package (never /tmp); NEVER the real ~/.claude.
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "enroll",
);

let scratch: string;
let regPath: string;
let settingsPath: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "e-"));
  regPath = join(scratch, "registry.json");
  settingsPath = join(scratch, "settings.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const START_CMD = "remote enroll --hook claude-start";
const END_CMD = "remote enroll --hook claude-end";

type Settings = {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  [k: string]: unknown;
};

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function countCommand(settings: Settings, event: string, command: string): number {
  return (settings.hooks?.[event] ?? []).reduce(
    (n, m) => n + (m.hooks ?? []).filter((h) => h.command === command).length,
    0,
  );
}

describe("installClaudeHooks", () => {
  it("creates settings.json with both hooks when none exists (no backup)", () => {
    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);
    expect(result.installed.sort()).toEqual(["SessionEnd", "SessionStart"]);
    expect(result.backupPath).toBeUndefined();
    const settings = readSettings();
    expect(countCommand(settings, "SessionStart", START_CMD)).toBe(1);
    expect(countCommand(settings, "SessionEnd", END_CMD)).toBe(1);
  });

  it("is idempotent: second run changes nothing, no duplicate, single backup", () => {
    // Pre-existing settings with user content + an unrelated SessionStart hook.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo user-hook" }] },
          ],
        },
      }),
      "utf8",
    );

    const first = installClaudeHooks(settingsPath);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    expect(existsSync(first.backupPath!)).toBe(true);
    // backup contains the PRE-modification content
    expect(JSON.parse(readFileSync(first.backupPath!, "utf8")).hooks.SessionStart).toHaveLength(1);

    const second = installClaudeHooks(settingsPath);
    expect(second.changed).toBe(false);
    expect(second.installed).toEqual([]);
    expect(second.backupPath).toBeUndefined();

    const settings = readSettings();
    // user hook untouched, ours present exactly once per event
    expect(countCommand(settings, "SessionStart", "echo user-hook")).toBe(1);
    expect(countCommand(settings, "SessionStart", START_CMD)).toBe(1);
    expect(countCommand(settings, "SessionEnd", END_CMD)).toBe(1);
    expect(settings.model).toBe("opus");
    // exactly one backup was created across the two runs
    const backups = readdirSync(scratch).filter((f) => f.includes(".bak."));
    expect(backups).toHaveLength(1);
  });

  it("refuses to overwrite a corrupt settings file", () => {
    writeFileSync(settingsPath, "{broken", "utf8");
    expect(() => installClaudeHooks(settingsPath)).toThrow(/not valid JSON/);
    expect(readFileSync(settingsPath, "utf8")).toBe("{broken");
  });
});

describe("handleClaudeHook", () => {
  const payload = JSON.stringify({
    session_id: "abc-123",
    cwd: "/home/u/src/projA",
    transcript_path: "/home/u/.claude/projects/x/abc-123.jsonl",
  });

  it("claude-start enrolls a local claude session with convId = session_id", () => {
    expect(handleClaudeHook("claude-start", payload, regPath)).toEqual({ ok: true });
    const entries = loadRegistry(regPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "abc-123",
      tool: "claude",
      kind: "local",
      cwd: "/home/u/src/projA",
      convId: "abc-123",
      source: "hook",
    });
    expect(entries[0]!.endedAt).toBeUndefined();
  });

  it("claude-end marks the session ended (enrolling it first if unknown)", () => {
    handleClaudeHook("claude-start", payload, regPath);
    expect(handleClaudeHook("claude-end", payload, regPath)).toEqual({ ok: true });
    expect(loadRegistry(regPath)[0]!.endedAt).toBeTruthy();

    const other = JSON.stringify({ session_id: "never-started", cwd: "/y" });
    expect(handleClaudeHook("claude-end", other, regPath)).toEqual({ ok: true });
    const entry = loadRegistry(regPath).find((e) => e.id === "never-started");
    expect(entry?.endedAt).toBeTruthy();
  });

  it("never throws: bad JSON, missing session_id, unknown hook -> ok:false", () => {
    expect(handleClaudeHook("claude-start", "not json", regPath).ok).toBe(false);
    expect(handleClaudeHook("claude-start", "{}", regPath).ok).toBe(false);
    expect(handleClaudeHook("claude-oops", payload, regPath).ok).toBe(false);
    expect(loadRegistry(regPath)).toEqual([]);
  });
});

describe("manualEnroll", () => {
  it("enrolls a local entry keyed by --conv with pid for liveness", () => {
    const result = manualEnroll(
      { tool: "codex", cwd: "/home/u/src/projB", conv: "roll-7", pid: "4242", label: "projB" },
      regPath,
    );
    expect(result.ok).toBe(true);
    expect(loadRegistry(regPath)[0]).toMatchObject({
      id: "roll-7",
      tool: "codex",
      kind: "local",
      cwd: "/home/u/src/projB",
      convId: "roll-7",
      pid: 4242,
      label: "projB",
      source: "run",
    });
  });

  it("rejects unknown tools and bad pids", () => {
    expect(manualEnroll({ tool: "vim" }, regPath).ok).toBe(false);
    expect(manualEnroll({ tool: "claude", pid: "abc" }, regPath).ok).toBe(false);
    expect(loadRegistry(regPath)).toEqual([]);
  });
});
