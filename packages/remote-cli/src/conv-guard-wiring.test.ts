/**
 * Wiring tests for the single-writer conversation guard in `remote run -r`
 * and `remote migrate forward -r` (same mock pattern as index.test.ts).
 * The registry is REAL, pointed at a scratch file via the config mock; live
 * local writers are simulated with kind "local" + pid = process.pid (alive).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Scratch dir inside the package (never /tmp), like the other test suites.
const SCRATCH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "conv-guard-wiring",
);
const CONFIG_PATH = join(SCRATCH, "config.json");
const REGISTRY_PATH = join(SCRATCH, "registry.json");

const listRemoteSessions = vi.fn();
const getDefaultRemote = vi.fn();
const startLocalSession = vi.fn();
const migrateForward = vi.fn();
const migrateBack = vi.fn();
const localConvStat = vi.fn();

vi.mock("./attach.js", () => ({
  attach: vi.fn(),
  createRemoteSession: vi.fn(),
  getRemoteSession: vi.fn(),
  listRemoteSessions,
  stopRemoteSession: vi.fn(),
  refreshRemoteSession: vi.fn(),
  sessionTerminalHealth: vi.fn(),
}));

vi.mock("./config.js", () => ({
  clearDefaultRemote: vi.fn(),
  getDefaultRemote,
  setDefaultRemote: vi.fn(),
  setToken: vi.fn(),
  getTunnel: () => undefined,
  setTunnel: () => {},
  getDefaultTarget: () => "scaleway-kapsule",
  setDefaultTarget: () => {},
  getDefaultTools: () => [],
  setDefaultTools: () => {},
  getPlugins: () => [],
  setPlugins: () => {},
  getH2aConfig: () => ({ enabled: false }),
  setH2aConfig: () => {},
  DEFAULT_SESSION_TARGET: "scaleway-kapsule",
  authHeaders: () => ({}),
  resolveConfigPath: () => CONFIG_PATH,
}));

vi.mock("./tmux.js", () => ({
  tmuxAvailable: () => true,
  startLocalSession,
  attachLocalSession: vi.fn(),
  attachPodTmux: vi.fn(),
  findLocalSession: vi.fn(),
  killLocalSession: vi.fn(),
  listLocalSessions: () => [],
}));

vi.mock("./migrate.js", () => ({
  migrateForward,
  migrateBack,
}));

// Controls how a BARE `migrate forward -r` resolves "the most recent local
// conversation" for the guard — the real localConvStat reads the runner's
// ~/.claude/projects, which must never leak into the test.
vi.mock("./convsync.js", () => ({
  encodeCwd: (cwd: string) => cwd.replace(/\//g, "-"),
  localConvStat,
  remoteConvStat: vi.fn(() => undefined),
  alignment: vi.fn(() => ({ state: "missing", detail: "" })),
}));

const stderrWrite = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);
const stdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => true);

const { main } = await import("./index.js");

const NOW = new Date().toISOString();

/** A LIVE local plain-terminal writer on convId (pid = ours, always alive). */
function liveLocalWriter(convId: string) {
  return {
    id: "uuid-claude-1",
    tool: "claude",
    kind: "local",
    cwd: "/home/u/src/projA",
    convId,
    pid: process.pid,
    enrolledAt: NOW,
    lastSeenAt: NOW,
    source: "hook",
  };
}

function writeRegistry(entries: unknown[]): void {
  writeFileSync(
    REGISTRY_PATH,
    JSON.stringify({ version: 1, entries }),
    "utf8",
  );
}

function stderrText(): string {
  return stderrWrite.mock.calls.map((c) => String(c[0])).join("");
}

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  writeRegistry([]);
  listRemoteSessions.mockReset();
  listRemoteSessions.mockResolvedValue([]);
  getDefaultRemote.mockReset();
  getDefaultRemote.mockReturnValue(undefined);
  startLocalSession.mockReset();
  startLocalSession.mockReturnValue({ name: "remote-projA", slug: "projA" });
  migrateForward.mockReset();
  migrateBack.mockReset();
  localConvStat.mockReset();
  localConvStat.mockReturnValue(undefined);
  stderrWrite.mockClear();
  stdoutWrite.mockClear();
  process.exitCode = 0;
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("remote run -r <conv> single-writer guard", () => {
  it("refuses when a live local session already holds the conversation", async () => {
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "run", "claude", "--resume", "conv-dup",
    ]);

    expect(exitCode).toBe(1);
    expect(startLocalSession).not.toHaveBeenCalled();
    expect(stderrText()).toContain(
      "conversation conv-dup already has a live writer",
    );
    expect(stderrText()).toContain("--force");
  });

  it("refuses when a live REMOTE session holds the conversation (cliSessionId)", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    listRemoteSessions.mockResolvedValue([
      { id: "sess-b", profile: "claude", target: "scaleway-kapsule", createdAt: NOW, cliSessionId: "conv-dup" },
    ]);

    const exitCode = await main([
      "node", "remote", "run", "claude", "--resume", "conv-dup",
    ]);

    expect(exitCode).toBe(1);
    expect(startLocalSession).not.toHaveBeenCalled();
    expect(stderrText()).toContain("sess-b");
  });

  it("--force overrides the guard with a warning and starts the session", async () => {
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "run", "claude", "--resume", "conv-dup", "--force",
    ]);

    expect(exitCode).toBe(0);
    expect(startLocalSession).toHaveBeenCalled();
    expect(stderrText()).toContain("--force");
    expect(stderrText()).toContain("corrupt");
  });

  it("proceeds when the live writer is on a DIFFERENT conversation", async () => {
    writeRegistry([liveLocalWriter("conv-other")]);

    const exitCode = await main([
      "node", "remote", "run", "claude", "--resume", "conv-dup",
    ]);

    expect(exitCode).toBe(0);
    expect(startLocalSession).toHaveBeenCalled();
  });

  it("still guards on the local registry when no remote is configured", async () => {
    // getDefaultRemote stays undefined -> no remote fetch, local-only guard
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "run", "claude", "--resume", "conv-dup",
    ]);

    expect(exitCode).toBe(1);
    expect(listRemoteSessions).not.toHaveBeenCalled();
  });
});

describe("remote migrate forward -r <conv> single-writer guard", () => {
  it("refuses while the conversation is still open locally", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r", "conv-dup",
    ]);

    expect(exitCode).toBe(1);
    expect(migrateForward).not.toHaveBeenCalled();
    expect(stderrText()).toContain(
      "conversation conv-dup already has a live writer",
    );
  });

  it("refuses when ANOTHER pod already holds the conversation", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    listRemoteSessions.mockResolvedValue([
      { id: "sess-b", profile: "claude", target: "scaleway-kapsule", createdAt: NOW, cliSessionId: "conv-dup" },
    ]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r", "conv-dup",
    ]);

    expect(exitCode).toBe(1);
    expect(migrateForward).not.toHaveBeenCalled();
    expect(stderrText()).toContain("remote stop sess-b");
  });

  it("--force overrides and proceeds with the migration", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r", "conv-dup", "--force",
    ]);

    expect(exitCode).toBe(0);
    expect(migrateForward).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "claude", resume: "conv-dup" }),
    );
  });

  it("bare --resume guards the resolved most-recent local conversation", async () => {
    // `-r` without a convId resolves "the most recent conversation" — that
    // resolution used to happen AFTER the guard, leaving it unprotected.
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    localConvStat.mockReturnValue({
      convId: "conv-dup",
      bytes: 10,
      lines: 2,
      sha: "abc",
    });
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r",
    ]);

    expect(exitCode).toBe(1);
    expect(migrateForward).not.toHaveBeenCalled();
    expect(localConvStat).toHaveBeenCalledWith(process.cwd());
    expect(stderrText()).toContain(
      "conversation conv-dup already has a live writer",
    );
    expect(stderrText()).toContain("--force");
  });

  it("bare --resume refuses when a POD already holds the resolved conversation", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    localConvStat.mockReturnValue({
      convId: "conv-dup",
      bytes: 10,
      lines: 2,
      sha: "abc",
    });
    listRemoteSessions.mockResolvedValue([
      { id: "sess-b", profile: "claude", target: "scaleway-kapsule", createdAt: NOW, cliSessionId: "conv-dup" },
    ]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r",
    ]);

    expect(exitCode).toBe(1);
    expect(migrateForward).not.toHaveBeenCalled();
    expect(stderrText()).toContain("remote stop sess-b");
  });

  it("bare --resume --force overrides the resolved-conversation guard", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    localConvStat.mockReturnValue({
      convId: "conv-dup",
      bytes: 10,
      lines: 2,
      sha: "abc",
    });
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r", "--force",
    ]);

    expect(exitCode).toBe(0);
    expect(migrateForward).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "claude", resume: true }),
    );
    expect(stderrText()).toContain("--force");
  });

  it("does not guard bare --resume when there is NO local conversation (unchanged)", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    localConvStat.mockReturnValue(undefined);
    writeRegistry([liveLocalWriter("conv-dup")]);

    const exitCode = await main([
      "node", "remote", "migrate", "forward", "claude", "-r",
    ]);

    expect(exitCode).toBe(0);
    expect(migrateForward).toHaveBeenCalled();
  });
});
