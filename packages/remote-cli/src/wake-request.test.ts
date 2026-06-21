/**
 * Tests for the wake-request handler (h2a 0.73.0 out-of-band Codex pane wake).
 *
 * Strategy: mock `node:child_process` to intercept all spawnSync calls (both
 * the tmux list-sessions / show-options reads and the send-keys nudge), write
 * wake-request envelopes into a real .test-scratch inbox, and assert on the resulting
 * spawnSync calls and on-disk .processed stamps.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH_ROOT = join(import.meta.dirname ?? process.cwd(), "..", ".test-scratch", "wake-request");
mkdirSync(SCRATCH_ROOT, { recursive: true });
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process BEFORE any module under test is loaded.
// ---------------------------------------------------------------------------
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

// ---------------------------------------------------------------------------
// Mock modules that require network / external infra not needed here.
// ---------------------------------------------------------------------------
vi.mock("./attach.js", () => ({
  attach: vi.fn(),
  createRemoteSession: vi.fn(),
  getRemoteSession: vi.fn(),
  listRemoteSessions: vi.fn(),
  stopRemoteSession: vi.fn(),
  refreshRemoteSession: vi.fn(),
  renameRemoteSession: vi.fn(),
  sessionTerminalHealth: vi.fn(),
}));
vi.mock("./auth-refresh.js", () => ({
  AuthRefreshError: class AuthRefreshError extends Error {},
  ensureProfileAuthFresh: vi.fn(),
}));
vi.mock("./auth-bundle.js", () => ({
  AuthBundleMissingError: class AuthBundleMissingError extends Error {},
  assertRequiredAuthBundle: vi.fn(),
  collectProfileAuth: vi.fn(),
}));
vi.mock("./soft-refresh.js", () => ({
  softRefreshSession: vi.fn(),
  probePodCredHealth: vi.fn(),
}));
vi.mock("./tunnel.js", () => ({
  ensureConnected: vi.fn(),
  stopTunnel: vi.fn(),
}));
vi.mock("./smoke.js", () => ({
  smokeRemoteProfile: vi.fn(),
}));
vi.mock("./workspace-sync.js", () => ({
  buildWorkspaceArchive: vi.fn(async () => Buffer.from("tgz")),
  uploadWorkspaceArchive: vi.fn(async () => {}),
}));
vi.mock("./workspace.js", () => ({
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(async () => []),
  deleteWorkspace: vi.fn(),
  readWorkspaceMarker: vi.fn(() => undefined),
  writeWorkspaceMarker: vi.fn(),
  acquireWorkspaceLock: vi.fn(),
  releaseWorkspaceLock: vi.fn(),
  lockHolderId: vi.fn(),
  readBaseSnapshot: vi.fn(),
  writeBaseSnapshot: vi.fn(),
  downloadWorkspaceExport: vi.fn(),
}));
vi.mock("./run.js", () => ({
  run: vi.fn(),
}));

vi.mock("./h2a-bridge.js", () => ({
  bridgeSession: vi.fn(),
  defaultLocalH2aRoot: () => "/nowhere-wake-test",
  instanceInboxDir: (instance: string) => instance.replace(/:/g, "__"),
}));

vi.mock("./config.js", () => ({
  clearDefaultRemote: vi.fn(),
  getDefaultRemote: vi.fn(),
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
  DEFAULT_SESSION_TARGET: "scaleway-kapsule",
  authHeaders: () => ({}),
  resolveConfigPath: () => join(SCRATCH_ROOT, "remote-wake-test-config.json"),
  getH2aConfig: () => undefined,
  getJobMaxAgeHours: () => 48,
  getMaxConcurrent: () => 4,
  getLayoutConfig: () => undefined,
}));

const stderrWrite = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);

const { main } = await import("./index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a wake-request envelope JSON for a target instance. */
function makeWakeEnvelope(
  target: string,
  reason = "stalled",
  instructionLine?: string,
): string {
  return JSON.stringify({
    protocol: "sentropic.h2a",
    version: "0.1",
    id: `env:wake:${target}`,
    type: "message",
    actor: { instance: "h2a:track:abc", role: "AGENTS", scope: "scope:default" },
    to: "remote:cli",
    body: {
      kind: "message",
      topic: "wake-request",
      request: {
        kind: "wake-request",
        target,
        reason,
        ...(instructionLine !== undefined ? { instructionLine } : {}),
      },
    },
    createdAt: new Date().toISOString(),
  });
}

/** Write a wake-request envelope into a local h2a inbox dir. */
function writeEnvelope(root: string, name: string, json: string): void {
  // readInboxEnvelopes reads from <root>/inbox/<any-dir>/*.json
  const dir = join(root, "inbox", "remote__cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), json, "utf8");
}

/**
 * Configure spawnSyncMock so that:
 *  - `tmux -V` → available
 *  - `tmux list-sessions` → one session `remote-<label>` with the given host
 *  - `tmux show-options @remote_agent_host` → host
 *  - `tmux show-options @remote_agent_pane` → paneId
 *  - `tmux show-options` for other options → empty
 *  - `tmux display-message` → session name `remote-<label>`
 *  - `tmux list-clients` → empty (no attached clients → fail-open, proceed)
 *  - `tmux send-keys` → success
 *  - all other calls → status 0 / empty
 */
function arrangeSession(
  label: string,
  host: string,
  paneId: string,
  clientActivityEpochSecs?: number,
): void {
  spawnSyncMock.mockImplementation((cmd: string, args: unknown[]) => {
    if (cmd !== "tmux") return { status: 0, stdout: "" };
    const sub = Array.isArray(args) ? String(args[0]) : "";
    if (sub === "-V") return { status: 0, stdout: "tmux 3.4\n" };
    if (sub === "list-sessions") {
      // Format: name\tattached\tpath\t@profile\t@display_name
      return {
        status: 0,
        stdout: `remote-${label}\t0\t/home/u/src/${label}\t${host}\t\n`,
      };
    }
    if (sub === "show-options") {
      const opt = String(args[args.length - 1]);
      if (opt === "@remote_agent_host") return { status: 0, stdout: `${host}\n` };
      if (opt === "@remote_agent_pane") return { status: 0, stdout: `${paneId}\n` };
      return { status: 0, stdout: "\n" };
    }
    if (sub === "display-message") return { status: 0, stdout: `remote-${label}\n` };
    if (sub === "list-clients") {
      if (clientActivityEpochSecs !== undefined) {
        return { status: 0, stdout: `${clientActivityEpochSecs}\n` };
      }
      return { status: 0, stdout: "" }; // no clients → fail-open
    }
    if (sub === "send-keys") return { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("remote wake-request", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(SCRATCH_ROOT, "inbox-"));
    spawnSyncMock.mockReset();
    stderrWrite.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("wakes the agent pane when a wake-request envelope exists and the pane is known", async () => {
    const target = "codex:remote:a6694dc87c1d";
    writeEnvelope(root, "wake-env-1", makeWakeEnvelope(target));
    arrangeSession("remote", "codex", "%42");

    const exitCode = await main(["node", "remote", "wake-request", "--root", root]);

    expect(exitCode).toBe(0);

    // Verify send-keys was called twice targeting pane %42:
    //  call 0: send-keys -t %42 -l "<instruction line>"  (instruction line)
    //  call 1: send-keys -t %42 Enter                    (submit)
    const sendKeysCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBe(2);
    for (const call of sendKeysCalls) {
      expect(call[1]).toContain("%42");
    }
    // Fallback path: no instructionLine in envelope → full command with --instance and --root.
    const literalLine = sendKeysCalls[0]![1][4] as string;
    expect(literalLine).toContain("--instance");
    expect(literalLine).toContain(target);
    expect(literalLine).toContain("--root");
    expect(literalLine).toContain(root);
    expect(sendKeysCalls[0]![1]).toEqual(["send-keys", "-t", "%42", "-l", literalLine]);
    expect(sendKeysCalls[1]![1]).toEqual(["send-keys", "-t", "%42", "Enter"]);

    const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain(`woke ${target}`);
    expect(out).toContain("%42");

    // F2: a .processed stamp must exist next to the envelope file.
    const inboxDir = join(root, "inbox", "remote__cli");
    const envelopes = readdirSync(inboxDir).filter((f) => f.endsWith(".json") && !f.endsWith(".processed"));
    expect(envelopes.length).toBe(1);
    expect(existsSync(join(inboxDir, `${envelopes[0]}.processed`))).toBe(true);
  });

  it("uses body.request.instructionLine verbatim when provided (h2a 0.73.0)", async () => {
    const target = "codex:remote:a6694dc87c1d";
    const customLine = "h2a inbox read --instance codex:x:y --root /custom";
    writeEnvelope(root, "wake-env-custom", makeWakeEnvelope(target, "stalled", customLine));
    arrangeSession("remote", "codex", "%99");

    const exitCode = await main(["node", "remote", "wake-request", "--root", root]);

    expect(exitCode).toBe(0);

    const sendKeysCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBe(2);
    // instructionLine from envelope must be used as-is (verbatim).
    expect(sendKeysCalls[0]![1]).toEqual(["send-keys", "-t", "%99", "-l", customLine]);
    expect(sendKeysCalls[1]![1]).toEqual(["send-keys", "-t", "%99", "Enter"]);
  });

  it("is a no-op when no pane is known for the target (agent not launched by remote)", async () => {
    const target = "codex:other-session:deadbeef";
    writeEnvelope(root, "wake-env-2", makeWakeEnvelope(target, "stalled work"));
    // No matching session in tmux
    spawnSyncMock.mockImplementation((cmd: string, args: unknown[]) => {
      if (cmd !== "tmux") return { status: 0, stdout: "" };
      const sub = Array.isArray(args) ? String(args[0]) : "";
      if (sub === "-V") return { status: 0, stdout: "tmux 3.4\n" };
      if (sub === "list-sessions") return { status: 0, stdout: "" };
      return { status: 0, stdout: "" };
    });

    const exitCode = await main(["node", "remote", "wake-request", "--root", root]);

    expect(exitCode).toBe(0);

    // No send-keys should have been called
    const sendKeysCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBe(0);

    const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("no agent pane");
  });

  it("defers send-keys when a human client was active within 4s (does not mark .processed)", async () => {
    const target = "codex:remote:a6694dc87c1d";
    writeEnvelope(root, "wake-env-defer", makeWakeEnvelope(target));
    // client_activity 2 seconds ago → within the 4s defer window.
    const recentEpochSecs = Math.floor((Date.now() - 2000) / 1000);
    arrangeSession("remote", "codex", "%42", recentEpochSecs);

    const exitCode = await main(["node", "remote", "wake-request", "--root", root]);

    expect(exitCode).toBe(0);

    // No send-keys must have been called.
    const sendKeysCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBe(0);

    // Envelope must NOT be marked .processed — watcher retries next tick.
    const inboxDir = join(root, "inbox", "remote__cli");
    const envelopes = readdirSync(inboxDir).filter((f) => f.endsWith(".json") && !f.endsWith(".processed"));
    expect(envelopes.length).toBe(1);
    const processedFiles = readdirSync(inboxDir).filter((f) => f.endsWith(".processed"));
    expect(processedFiles.length).toBe(0);

    const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("deferring");
    expect(out).toContain(target);
  });

  it("skips a second wake-request for the same target: .processed stamp prevents re-fire", async () => {
    // Two separate invocations of `wake-request --root <same-dir>` for the same
    // target — the second pass must be a no-op because F2 marks the envelope
    // .processed on the first pass, so readWakeEnvelopeFiles skips it entirely.
    const target = "codex:remote:abc123";
    writeEnvelope(root, "wake-env-3", makeWakeEnvelope(target));
    arrangeSession("remote", "codex", "%7");

    // First pass: wakes the pane, writes .processed stamp.
    await main(["node", "remote", "wake-request", "--root", root]);

    spawnSyncMock.mockClear();
    stderrWrite.mockClear();

    // Re-arrange so tmux is still "available" for the second pass.
    arrangeSession("remote", "codex", "%7");

    // Second pass: envelope is already .processed → file is skipped entirely →
    // zero send-keys calls and "0 pane(s) woken" in stderr.
    await main(["node", "remote", "wake-request", "--root", root]);

    const sendKeysCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBe(0);

    const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    // The .processed guard skips at the file level — no "already woken" message,
    // just the "0 pane(s) woken" summary from the command action.
    expect(out).toContain("0 pane(s) woken");
  });
});
