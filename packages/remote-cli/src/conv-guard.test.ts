import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { convOwners, formatConvConflict, guardConvWriters } from "./conv-guard.js";
import type { RegistryEntry } from "./registry.js";

// Scratch dir inside the package (never /tmp), like the other test suites.
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "conv-guard",
);

let scratch: string;
let regPath: string;

const stderr = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "g-"));
  regPath = join(scratch, "registry.json");
  stderr.mockClear();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeRegistry(entries: RegistryEntry[]): void {
  writeFileSync(regPath, JSON.stringify({ version: 1, entries }), "utf8");
}

const NOW = "2026-06-07T10:00:00.000Z";

function entry(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: "e-1",
    tool: "claude",
    kind: "local-tmux",
    cwd: "/home/u/src/projA",
    enrolledAt: NOW,
    lastSeenAt: NOW,
    source: "run",
    ...over,
  };
}

describe("convOwners", () => {
  it("flags a live local tmux session holding the same convId", () => {
    writeRegistry([
      entry({
        id: "projA",
        label: "projA",
        tmuxSession: "remote-projA",
        convId: "conv-1",
      }),
    ]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      tmuxHasSession: () => true,
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ where: "local-tmux", label: "projA" });
    expect(owners[0]!.detail).toContain("remote stop projA");
    expect(owners[0]!.suspect).toBeUndefined();
  });

  it("flags a live plain-terminal (hook-enrolled) local session by pid", () => {
    writeRegistry([
      entry({
        id: "uuid-claude-1",
        kind: "local",
        convId: "conv-1",
        pid: 4242,
        source: "hook",
      }),
    ]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      pidAlive: (pid) => pid === 4242,
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ where: "local" });
    expect(owners[0]!.detail).toContain("pid 4242");
  });

  it("ignores dead entries, other convIds, the excluded id, and registry remote entries", () => {
    writeRegistry([
      // dead tmux session (probe says no)
      entry({ id: "dead", tmuxSession: "remote-dead", convId: "conv-1" }),
      // live but a DIFFERENT conversation
      entry({ id: "other", tmuxSession: "remote-other", convId: "conv-2" }),
      // live, same conv, but it's the entry the caller is creating/reviving
      entry({ id: "self", tmuxSession: "remote-self", convId: "conv-1" }),
      // registry "remote" entries are stale-prone — remoteSessions is authoritative
      entry({ id: "r-1", kind: "remote", convId: "conv-1", source: "remote" }),
    ]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      tmuxHasSession: (name) => name !== "remote-dead",
      excludeId: "self",
    });
    expect(owners).toEqual([]);
  });

  it("flags a live remote session whose cliSessionId matches", () => {
    writeRegistry([]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      remoteSessions: [
        { id: "sess-a", cliSessionId: "conv-other" },
        {
          id: "sess-b",
          displayName: "projA",
          cliSessionId: "conv-1",
          workspacePath: "/home/u/src/projA",
        },
      ],
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ where: "remote", label: "projA" });
    expect(owners[0]!.detail).toContain("remote stop sess-b");
    expect(owners[0]!.suspect).toBeUndefined();
  });

  it("marks a same-path remote session WITHOUT cliSessionId as suspect (warning-grade)", () => {
    writeRegistry([]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      cwd: "/home/u/src/projA",
      remoteSessions: [
        { id: "sess-b", workspacePath: "/home/u/src/projA" },
        { id: "sess-c", workspacePath: "/home/u/src/other" },
      ],
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ where: "remote", suspect: true });
    expect(owners[0]!.detail).toContain("sess-b");
  });

  it("returns empty when nothing holds the conversation", () => {
    writeRegistry([
      entry({ id: "other", tmuxSession: "remote-other", convId: "conv-2" }),
    ]);
    const owners = convOwners("conv-1", {
      registryPath: regPath,
      tmuxHasSession: () => true,
      cwd: "/home/u/src/projA",
      remoteSessions: [{ id: "sess-a", cliSessionId: "conv-9" }],
    });
    expect(owners).toEqual([]);
  });
});

describe("guardConvWriters", () => {
  function stderrText(): string {
    return stderr.mock.calls.map((c) => String(c[0])).join("");
  }

  it("refuses on a hard local conflict (returns false, explains where + how)", async () => {
    writeRegistry([
      entry({
        id: "projA",
        label: "projA",
        tmuxSession: "remote-projA",
        convId: "conv-1",
      }),
    ]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      tmuxHasSession: () => true,
    });
    expect(ok).toBe(false);
    expect(stderrText()).toContain("conversation conv-1 already has a live writer");
    expect(stderrText()).toContain("remote stop projA");
    expect(stderrText()).toContain("--force");
  });

  it("refuses on a hard remote conflict (cliSessionId match)", async () => {
    writeRegistry([]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      fetchRemoteSessions: async () => [
        { id: "sess-b", cliSessionId: "conv-1" },
      ],
    });
    expect(ok).toBe(false);
    expect(stderrText()).toContain("[remote] conversation conv-1");
    expect(stderrText()).toContain("sess-b");
  });

  it("--force overrides the refusal with a loud warning", async () => {
    writeRegistry([
      entry({
        id: "projA",
        tmuxSession: "remote-projA",
        convId: "conv-1",
      }),
    ]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      tmuxHasSession: () => true,
      force: true,
    });
    expect(ok).toBe(true);
    expect(stderrText()).toContain("--force");
    expect(stderrText()).toContain("corrupt");
  });

  it("suspect-only remote match warns but proceeds", async () => {
    writeRegistry([]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      fetchRemoteSessions: async () => [
        { id: "sess-b", workspacePath: "/home/u/src/projA" },
      ],
    });
    expect(ok).toBe(true);
    expect(stderrText()).toContain("warning");
    expect(stderrText()).toContain("sess-b");
  });

  it("degrades to local-only when the remote fetch throws", async () => {
    writeRegistry([]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      fetchRemoteSessions: async () => {
        throw new Error("tunnel down");
      },
    });
    expect(ok).toBe(true);
    expect(stderrText()).toBe("");
  });

  it("proceeds silently when nothing holds the conversation", async () => {
    writeRegistry([]);
    const ok = await guardConvWriters({
      convId: "conv-1",
      cwd: "/home/u/src/projA",
      registryPath: regPath,
      fetchRemoteSessions: async () => [],
    });
    expect(ok).toBe(true);
    expect(stderrText()).toBe("");
  });
});

describe("formatConvConflict", () => {
  it("lists every owner with its location tag", () => {
    const msg = formatConvConflict("conv-1", [
      { where: "local-tmux", label: "projA", detail: "tmux remote-projA" },
      { where: "remote", label: "sess-b", detail: "pod sess-b" },
    ]);
    expect(msg).toContain("[local-tmux] projA");
    expect(msg).toContain("[remote] sess-b");
    expect(msg).toContain("--force");
  });
});
